import * as crypto from 'crypto';
import * as stream from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as k8s from '@kubernetes/client-node';
import { Logger } from '../util/Logger';
import { ServerConfig } from './ServerConfig';
import { triggerBackgroundExtensionInstall } from './ExtensionInstaller';

export interface ServerInstallResult {
  /** Connection token for authenticating to the REH server */
  connectionToken: string;
  /** Full path to the server script on the remote */
  serverScript: string;
  /** Port the REH server is listening on */
  listeningOn: number;
  /** Remote platform (linux, darwin) */
  platform: string;
  /** Remote architecture (x64, arm64) */
  arch: string;
}

class ServerInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerInstallError';
  }
}

interface TransferRequest {
  downloadUrl: string;
  destFile: string;
}

/**
 * Install the Kiro REH server on a workspace pod via K8s exec.
 *
 * Runs a bash script that:
 * 1. Detects platform and architecture
 * 2. Downloads the REH tarball from the configured URL
 * 3. Extracts it to ~/.kiro-server/bin/<commit>/
 * 4. Reports back the server script path and connection token
 *
 * No SSH needed — uses K8s exec directly.
 */
export async function installServerViaExec(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  config: ServerConfig,
  overrideConnectionToken?: string
): Promise<ServerInstallResult> {
  const logger = Logger.getInstance();
  const scriptId = crypto.randomBytes(12).toString('hex');
  const connectionToken = overrideConnectionToken ?? crypto.randomUUID();

  const script = generateInstallScript({
    id: scriptId,
    connectionToken,
    ...config,
  });

  logger.info(`Installing REH server on ${podName}/${containerName} via K8s exec`);

  // Execute the install script via K8s exec with monitoring for transfer requests
  const output = await execInPodWithMonitoring(
    kubeConfig,
    namespace,
    podName,
    containerName,
    ['bash', '-c', script]
  );

  logger.debug(`Server install output:\n${output.replace(/connectionToken==.*?==/g, 'connectionToken==<redacted>==')}`);

  const result = parseInstallOutput(output, scriptId);
  if (!result) {
    throw new ServerInstallError(
      `Failed to parse REH server install output. Raw output:\n${output.slice(0, 500)}`
    );
  }

  const exitCode = parseInt(result['exitCode'] ?? '-1', 10);
  if (exitCode !== 0) {
    throw new ServerInstallError(
      `REH server install exited with code ${exitCode}. Output:\n${output.slice(0, 500)}`
    );
  }

  if (!result['serverScript']) {
    throw new ServerInstallError('REH server did not report server script path');
  }

  const listeningOn = parseInt(result['listeningOn'] ?? '0', 10);
  if (!listeningOn) {
    throw new ServerInstallError('REH server did not report a listening port');
  }

  logger.info(
    `REH server ready: script=${result['serverScript']}, port=${listeningOn}, platform=${result['platform']}, arch=${result['arch']}`
  );

  const installResult: ServerInstallResult = {
    connectionToken,
    serverScript: result['serverScript'],
    listeningOn,
    platform: result['platform'] ?? 'linux',
    arch: result['arch'] ?? 'x64',
  };

  void triggerBackgroundExtensionInstall(
    kubeConfig,
    namespace,
    podName,
    containerName,
    installResult
  ).catch((err) => {
    logger.warn(`Background extension pre-install failed to start: ${err}`);
  });

  return installResult;
}

/**
 * Execute a command in a pod container and return stdout.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function execInPod(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const exec = new k8s.Exec(kubeConfig);
    let stdout = '';
    let stderr = '';

    const stdoutStream = new stream.Writable({
      write(chunk: Buffer, _encoding, callback) {
        stdout += chunk.toString();
        callback();
      },
    });

    const stderrStream = new stream.Writable({
      write(chunk: Buffer, _encoding, callback) {
        stderr += chunk.toString();
        callback();
      },
    });

    exec
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdoutStream,
        stderrStream,
        null, // stdin
        false, // tty
        (status: k8s.V1Status) => {
          if (status.status === 'Success') {
            resolve(stdout);
          } else {
            reject(
              new ServerInstallError(
                `Exec failed: ${status.message ?? stderr.trim()}`
              )
            );
          }
        }
      )
      .catch(reject);
  });
}

/**
 * Execute a command in a pod and monitor stdout for transfer requests.
 * When a transfer request is detected, initiates client-side download and upload.
 */
async function execInPodWithMonitoring(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[]
): Promise<string> {
  const logger = Logger.getInstance();
  const exec = new k8s.Exec(kubeConfig);
  let stdout = '';
  let stderr = '';
  let transferHandled = false;

  const stdoutStream = new stream.Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString();
      stdout += text;

      // Check for transfer request in real-time (only handle once)
      if (!transferHandled &&
          stdout.includes('__DEVSPACES_TRANSFER_REQUEST__') &&
          stdout.includes('__DEVSPACES_TRANSFER_END__')) {
        transferHandled = true;
        const request = parseTransferRequest(stdout);
        if (request) {
          logger.info('Transfer request detected, initiating client download...');
          // Trigger download asynchronously while script continues
          handleClientDownload(
            kubeConfig, namespace, podName, containerName, request
          ).catch(err => logger.error(`Client download failed: ${err}`));
        }
      }

      callback();
    },
  });

  const stderrStream = new stream.Writable({
    write(chunk: Buffer, _encoding, callback) {
      stderr += chunk.toString();
      callback();
    },
  });

  await new Promise<void>((resolve, reject) => {
    exec.exec(
      namespace, podName, containerName, command,
      stdoutStream, stderrStream, null, false,
      (status: k8s.V1Status) => {
        if (status.status === 'Success') {
          resolve();
        } else {
          reject(new ServerInstallError(
            `Exec failed: ${status.message ?? stderr.trim()}`
          ));
        }
      }
    ).catch(reject);
  });

  return stdout;
}

/**
 * Parse transfer request markers from script output.
 */
function parseTransferRequest(output: string): TransferRequest | null {
  const startIdx = output.indexOf('__DEVSPACES_TRANSFER_REQUEST__');
  const endIdx = output.indexOf('__DEVSPACES_TRANSFER_END__');

  if (startIdx < 0 || endIdx < 0) return null;

  const block = output.substring(startIdx, endIdx);
  const lines = block.split(/\r?\n/);

  let downloadUrl = '';
  let destFile = '';

  for (const line of lines) {
    if (line.startsWith('downloadUrl==')) {
      downloadUrl = line.substring(13).replace(/==$/, '');
    }
    if (line.startsWith('destFile==')) {
      destFile = line.substring(10).replace(/==$/, '');
    }
  }

  return downloadUrl && destFile ? { downloadUrl, destFile } : null;
}

/**
 * Download tarball from URL and upload to pod using k8s.Cp.
 */
async function handleClientDownload(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  request: TransferRequest
): Promise<void> {
  const logger = Logger.getInstance();
  logger.info(`Client-side download: ${request.downloadUrl}`);

  // Download to temp directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-'));
  const localFile = path.join(tempDir, 'vscode-server.tar.gz');

  try {
    await downloadFile(request.downloadUrl, localFile);
    logger.info(`Downloaded tarball (${(fs.statSync(localFile).size / 1024 / 1024).toFixed(1)} MB)`);

    await uploadViaStreaming(
      kubeConfig, namespace, podName, containerName,
      localFile, request.destFile
    );

    logger.info(`Uploaded to ${podName}:${request.destFile}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Upload file to pod using stdin streaming.
 * Streams binary data directly - much faster than chunking.
 */
async function uploadViaStreaming(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  localFile: string,
  destFile: string
): Promise<void> {
  const logger = Logger.getInstance();
  const fileSize = fs.statSync(localFile).size;
  logger.info(`Uploading file via stdin streaming (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

  const exec = new k8s.Exec(kubeConfig);
  const readStream = fs.createReadStream(localFile);
  let stderr = '';

  const stderrStream = new stream.Writable({
    write(chunk: Buffer, _encoding, callback) {
      stderr += chunk.toString();
      callback();
    },
  });

  await new Promise<void>((resolve, reject) => {
    exec.exec(
      namespace,
      podName,
      containerName,
      // Stream to a temp file, then atomically rename into place so the
      // remote poll loop only sees the final path once the upload is complete.
      ['sh', '-c', `cat > ${destFile}.part && mv ${destFile}.part ${destFile}`],
      null,  // stdout - not needed
      stderrStream,
      readStream,  // stdin - stream the file
      false,  // tty
      (status: k8s.V1Status) => {
        if (status.status === 'Success') {
          resolve();
        } else {
          reject(new ServerInstallError(
            `Upload failed: ${status.message ?? stderr.trim()}`
          ));
        }
      }
    ).catch(reject);
  });

  logger.info(`Upload complete`);
}

/**
 * Download file from URL with redirect support.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const https = await import('https');
  const http = await import('http');

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, (response) => {
      // Follow redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const location = response.headers.location;
        if (!location) {
          reject(new Error('Redirect without location header'));
          return;
        }
        return downloadFile(location, destPath).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(destPath);
      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', (err) => {
        fs.unlink(destPath, () => reject(err));
      });
    }).on('error', reject);
  });
}

function parseInstallOutput(
  output: string,
  scriptId: string
): Record<string, string> | undefined {
  const startMarker = `${scriptId}: start`;
  const endMarker = `${scriptId}: end`;

  const startIdx = output.indexOf(startMarker);
  if (startIdx < 0) {
    return undefined;
  }

  const endIdx = output.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx < 0) {
    return undefined;
  }

  const block = output.substring(startIdx + startMarker.length, endIdx);
  const result: Record<string, string> = {};

  for (const line of block.split(/\r?\n/)) {
    const eqIdx = line.indexOf('==');
    if (eqIdx > 0) {
      const key = line.substring(0, eqIdx);
      const val = line.substring(eqIdx + 2).replace(/==$/, '');
      result[key] = val;
    }
  }

  return result;
}

interface ScriptOptions extends ServerConfig {
  id: string;
  connectionToken: string;
}

function generateInstallScript(opts: ScriptOptions): string {
  // Validate all values that will be interpolated into the shell script.
  // These should only contain safe characters (alphanumeric, hyphens, dots, slashes).
  const safePattern = /^[a-zA-Z0-9._\-\/]+$/;
  for (const [key, value] of Object.entries({
    commit: opts.commit,
    version: opts.version,
    quality: opts.quality,
    connectionToken: opts.connectionToken,
    serverApplicationName: opts.serverApplicationName,
    serverDataFolderName: opts.serverDataFolderName,
    id: opts.id,
  })) {
    if (!safePattern.test(value)) {
      throw new ServerInstallError(
        `Unsafe value for ${key}: contains shell-unsafe characters`
      );
    }
  }

  // Validate the download URL template — must be a valid URL pattern
  if (!opts.downloadUrlTemplate) {
    throw new ServerInstallError(
      'No REH server download URL configured. Set "devspaces.rehDownloadUrl" in settings or ensure your IDE\'s product.json contains "serverDownloadUrlTemplate".'
    );
  }

  const sanitizedUrl = opts.downloadUrlTemplate.replace(/\$\{[^}]+\}/g, 'dummy');
  if (!URL.canParse(sanitizedUrl)) {
    throw new ServerInstallError('Unsafe download URL template');
  }

  // Pre-build a URL template using bash variable references.
  // The original template uses ${commit}, ${os}, ${arch} etc.
  // We replace them with bash variables that the script sets.
  const urlTemplate = opts.downloadUrlTemplate
    .replace(/\$\{quality\}/g, opts.quality)
    .replace(/\$\{version\}/g, opts.version)
    .replace(/\$\{commit\}/g, opts.commit)
    .replace(/\$\{os\}/g, '$PLATFORM')
    .replace(/\$\{arch\}/g, '$SERVER_ARCH');

  return `
# Kiro REH Server installation script (DevSpaces v2 — K8s exec)

TMP_DIR="\${XDG_RUNTIME_DIR:-"/tmp"}"

# Determine writable data directory (try $HOME first, fallback to /var/tmp/user/)
if [ -w "$HOME" ]; then
    SERVER_DATA_DIR="$HOME/${opts.serverDataFolderName}"
else
    echo "Warning: $HOME is not writable, using /var/tmp/user/ instead"
    mkdir -p /var/tmp/user 2>/dev/null
    SERVER_DATA_DIR="/var/tmp/user/${opts.serverDataFolderName}"
fi

DISTRO_VERSION="${opts.version}"
DISTRO_COMMIT="${opts.commit}"
DISTRO_QUALITY="${opts.quality}"

SERVER_APP_NAME="${opts.serverApplicationName}"
SERVER_DIR="$SERVER_DATA_DIR/bin/$DISTRO_COMMIT"
SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
SERVER_ARCH=
SERVER_CONNECTION_TOKEN="${opts.connectionToken}"
SERVER_DOWNLOAD_URL=

OS_RELEASE_ID=
ARCH=
PLATFORM=

print_install_results_and_exit() {
    echo "${opts.id}: start"
    echo "exitCode==$1=="
    echo "serverScript==$SERVER_SCRIPT=="
    echo "listeningOn==$LISTENING_ON=="
    echo "connectionToken==$SERVER_CONNECTION_TOKEN=="
    echo "osReleaseId==$OS_RELEASE_ID=="
    echo "arch==$ARCH=="
    echo "platform==$PLATFORM=="
    echo "tmpDir==$TMP_DIR=="
    echo "${opts.id}: end"
    exit 0
}

KERNEL="$(uname -s)"
case $KERNEL in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="darwin" ;;
    *)
        echo "Error: unsupported platform $KERNEL"
        print_install_results_and_exit 1
        ;;
esac

ARCH="$(uname -m)"
case $ARCH in
    x86_64 | amd64)    SERVER_ARCH="x64" ;;
    arm64 | aarch64)   SERVER_ARCH="arm64" ;;
    armv7l | armv8l)   SERVER_ARCH="armhf" ;;
    *)
        echo "Error: unsupported architecture $ARCH"
        print_install_results_and_exit 1
        ;;
esac

OS_RELEASE_ID="$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
if [ -z "$OS_RELEASE_ID" ]; then
    OS_RELEASE_ID="unknown"
fi

mkdir -p "$SERVER_DIR" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "Error creating server install directory"
    print_install_results_and_exit 1
fi

SERVER_DOWNLOAD_URL="${urlTemplate}"

if [ ! -f "$SERVER_SCRIPT" ]; then
    echo "Downloading server from $SERVER_DOWNLOAD_URL"
    cd "$SERVER_DIR" || exit 1

    if command -v wget > /dev/null 2>&1; then
        wget --tries=3 --timeout=10 --continue --no-verbose -O vscode-server.tar.gz "$SERVER_DOWNLOAD_URL"
    elif command -v curl > /dev/null 2>&1; then
        curl --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz "$SERVER_DOWNLOAD_URL"
    else
        echo "Error: no wget or curl available"
        print_install_results_and_exit 1
    fi

    if [ $? -ne 0 ]; then
        echo "Error downloading server from $SERVER_DOWNLOAD_URL"
        rm -f vscode-server.tar.gz

        # Request client-side download as fallback
        echo "__DEVSPACES_TRANSFER_REQUEST__"
        echo "downloadUrl==$SERVER_DOWNLOAD_URL=="
        echo "destFile==$SERVER_DIR/vscode-server.tar.gz=="
        echo "__DEVSPACES_TRANSFER_END__"
        echo "Waiting for client to upload tarball..."

        # Poll for transferred file (up to 5 minutes)
        # Large downloads (200+ MB) over restricted networks can take time
        for i in \$(seq 1 300); do
            if [ -f "$SERVER_DIR/vscode-server.tar.gz" ]; then
                echo "Client transfer complete"
                break
            fi
            sleep 1s
        done

        if [ ! -f "$SERVER_DIR/vscode-server.tar.gz" ]; then
            echo "Timeout waiting for client transfer"
            print_install_results_and_exit 1
        fi
    fi

    tar -xf vscode-server.tar.gz --strip-components 1
    if [ $? -ne 0 ]; then
        echo "Error extracting server archive"
        print_install_results_and_exit 1
    fi

    rm -f vscode-server.tar.gz

    if [ ! -f "$SERVER_SCRIPT" ]; then
        echo "Error: server binary not found after extraction"
        print_install_results_and_exit 1
    fi

    echo "Server installed to $SERVER_DIR"
else
    echo "Server already installed at $SERVER_SCRIPT"
fi

# Always kill existing server and start fresh — reconnection requires
# a new connection token that matches what the resolver returns.
LISTENING_ON=
SERVER_TOKENFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.token"
SERVER_LOGFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.log"
SERVER_PIDFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.pid"

if [ -f "$SERVER_PIDFILE" ]; then
    OLD_PID="$(cat "$SERVER_PIDFILE")"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        kill "$OLD_PID" 2>/dev/null
        echo "Killed existing server (PID $OLD_PID)"
        sleep 1
    fi
    rm -f "$SERVER_PIDFILE"
fi

# Start the server
rm -f "$SERVER_LOGFILE" "$SERVER_TOKENFILE"
echo "$SERVER_CONNECTION_TOKEN" > "$SERVER_TOKENFILE"
chmod 600 "$SERVER_TOKENFILE"

"$SERVER_SCRIPT" --start-server --host=127.0.0.1 --port=0 \
    --connection-token-file "$SERVER_TOKENFILE" \
    --telemetry-level off \
    --enable-remote-auto-shutdown \
    --accept-server-license-terms &> "$SERVER_LOGFILE" &
echo $! > "$SERVER_PIDFILE"

# Wait for server to start listening
for i in 1 2 3 4 5 6 7 8 9 10; do
    if [ -f "$SERVER_LOGFILE" ]; then
        LISTENING_ON="$(grep -oE 'Extension host agent listening on [0-9]+' "$SERVER_LOGFILE" | grep -oE '[0-9]+' | tail -1)"
        if [ -n "$LISTENING_ON" ]; then
            break
        fi
    fi
    sleep 0.5
done

if [ -z "$LISTENING_ON" ]; then
    echo "Error: server did not start within timeout"
    if [ -f "$SERVER_LOGFILE" ]; then
        echo "--- Server log ---"
        tail -20 "$SERVER_LOGFILE"
        echo "--- End server log ---"
    fi
    print_install_results_and_exit 1
fi

print_install_results_and_exit 0
`;
}
