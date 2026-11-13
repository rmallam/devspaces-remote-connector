import * as vscode from 'vscode';
import * as path from 'path';
import * as stream from 'stream';
import * as k8s from '@kubernetes/client-node';
import { CONFIG_SECTION, PROJECTS_ROOT } from '../constants';
import { Logger } from '../util/Logger';
import type { ServerInstallResult } from './ServerSetup';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExtensionPreinstallSettings {
  enabled: boolean;
  defaultExtensions: string[];
  openVsxUrl: string;
  vsixMirrorUrlTemplate: string;
}

export interface ParsedExtensionSpec {
  kind: 'id' | 'url';
  /** Normalized lowercase `publisher.name` when kind === 'id' */
  id?: string;
  publisher?: string;
  name?: string;
  version?: string;
  /** Validated HTTPS/in-cluster `.vsix` URL when kind === 'url' */
  url?: string;
}

export interface RemoteInstallerConfig {
  serverScript: string;
  serverDir: string;
  serverDataDir: string;
  platform: string;
  arch: string;
  projectsRoot: string;
  defaultExtensions: string[];
  openVsxUrl: string;
  vsixMirrorUrlTemplate: string;
}

export interface RemoteInstallerDeps {
  /** Override HTTP/HTTPS fetcher in unit tests */
  fetchBuffer?: (url: string, timeoutMs: number, maxBytes: number) => Promise<{ statusCode: number; body: Buffer }>;
  /** Override CLI execution in unit tests */
  execServerCli?: (serverScript: string, args: string[]) => void;
  /** Override internal server-config endpoints in unit tests */
  serverConfigUrls?: string[];
  /** Override logger in unit tests */
  log?: (msg: string) => void;
}

export interface RemoteInstallerSummary {
  installedVsixCount: number;
  skippedAlreadyInstalled: number;
  failedExtensions: string[];
}

// ─── Validation Helpers (Shared Reference Logic) ─────────────────────────────

const EXTENSION_PART_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const EXTENSION_VERSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;
const SAFE_POSIX_PATH_RE = /^\/[a-zA-Z0-9._\-/]+$/;
const SAFE_ARCH_RE = /^(x64|arm64|armhf)$/;
const SAFE_PLATFORM_RE = /^(linux|darwin)$/;
const IN_CLUSTER_SVC_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\.svc(?:\.cluster\.local)?)$/;

/**
 * Validate that a URL is safe to contact for extension metadata or VSIX downloads.
 *
 * Security policy:
 * - External hosts MUST use `https:` (TLS verification is always enforced).
 * - Plain `http:` is permitted ONLY for Kubernetes in-cluster `.svc` endpoints
 *   (such as `devspaces-dashboard.openshift-devspaces.svc:8080` and
 *   `plugin-registry.openshift-devspaces.svc:8080`).
 * - Rejects embedded credentials, fragments, localhost, and link-local IPs.
 */
export function isAllowedEndpointUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password || parsed.hash) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('169.254.')
  ) {
    return false;
  }

  if (parsed.protocol === 'https:') {
    return true;
  }

  if (parsed.protocol === 'http:') {
    return IN_CLUSTER_SVC_HOST_RE.test(host);
  }

  return false;
}

/**
 * Validate an HTTPS VSIX mirror URL template containing `${publisher}`,
 * `${name}`, and optional `${version}` placeholders.
 */
export function isValidVsixMirrorTemplate(template: string): boolean {
  if (!template || typeof template !== 'string' || template.length > 2048) {
    return false;
  }
  // Only allow known placeholders
  const stripped = template.replace(/\$\{(publisher|name|version)\}/g, 'placeholder');
  if (stripped.includes('${') || stripped.includes('`') || stripped.includes('\n') || stripped.includes('\r')) {
    return false;
  }
  if (!stripped.startsWith('https://')) {
    return false;
  }
  return isAllowedEndpointUrl(stripped);
}

/**
 * Parse and validate an extension specification from settings, `.vscode/extensions.json`,
 * or `CheCluster.spec.devEnvironments.defaultPlugins`.
 *
 * Supported formats:
 * - `publisher.name` or `publisher.name@1.2.3`
 * - `open-vsx:publisher/name` or `open-vsx:publisher/name/1.2.3`
 * - `publisher/name/latest` or `publisher/name/1.2.3` (Che/Dev Spaces plugin ID format)
 * - Direct `.vsix` URL (`https://.../*.vsix`)
 */
export function parseExtensionEntry(raw: string): ParsedExtensionSpec | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) {
    return undefined;
  }

  // Direct .vsix URL
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    if (!isAllowedEndpointUrl(trimmed)) {
      return undefined;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.pathname.toLowerCase().endsWith('.vsix')) {
        return { kind: 'url', url: trimmed };
      }
      // OpenVSX URL inside CheCluster defaultPlugins, e.g. https://open-vsx.org/api/redhat/vscode-yaml/1.24.0
      const ovsxMatch = parsed.pathname.match(/\/api\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)(?:\/([a-zA-Z0-9._+-]+))?\/?$/);
      if (ovsxMatch) {
        const [, pub, extName, ver] = ovsxMatch;
        return buildIdSpec(pub, extName, ver && ver !== 'latest' ? ver : undefined);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  // `open-vsx:publisher/name[/version]`
  const withoutScheme = trimmed.startsWith('open-vsx:')
    ? trimmed.slice('open-vsx:'.length)
    : trimmed;

  // Slash-delimited Che format: `publisher/name` or `publisher/name/version`
  if (withoutScheme.includes('/')) {
    const parts = withoutScheme.split('/');
    if (parts.length === 2 || parts.length === 3) {
      const [pub, extName, ver] = parts;
      return buildIdSpec(pub, extName, ver && ver !== 'latest' ? ver : undefined);
    }
    return undefined;
  }

  // Standard VS Code format: `publisher.name` or `publisher.name@version`
  const atIdx = withoutScheme.indexOf('@');
  const idPart = atIdx >= 0 ? withoutScheme.slice(0, atIdx) : withoutScheme;
  const versionPart = atIdx >= 0 ? withoutScheme.slice(atIdx + 1) : undefined;

  const dotIdx = idPart.indexOf('.');
  if (dotIdx <= 0 || dotIdx === idPart.length - 1) {
    return undefined;
  }
  const publisher = idPart.slice(0, dotIdx);
  const name = idPart.slice(dotIdx + 1);
  if (name.includes('/')) {
    return undefined;
  }

  return buildIdSpec(publisher, name, versionPart && versionPart !== 'latest' ? versionPart : undefined);
}

function buildIdSpec(publisher: string, name: string, version?: string): ParsedExtensionSpec | undefined {
  if (!EXTENSION_PART_RE.test(publisher) || !EXTENSION_PART_RE.test(name)) {
    return undefined;
  }
  if (publisher === '.' || publisher === '..' || name === '.' || name === '..') {
    return undefined;
  }
  if (version !== undefined) {
    if (!EXTENSION_VERSION_RE.test(version) || version === '.' || version === '..') {
      return undefined;
    }
  }
  const pubLower = publisher.toLowerCase();
  const nameLower = name.toLowerCase();
  return {
    kind: 'id',
    id: `${pubLower}.${nameLower}`,
    publisher: pubLower,
    name: nameLower,
    version,
  };
}

/**
 * Strip single-line (`//`) and multi-line (`/* ... * /`) comments and trailing commas
 * so `.vscode/extensions.json` (JSONC) files parse cleanly with `JSON.parse`.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  // Remove trailing commas before `}` or `]` outside strings
  const cleaned = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned);
}

// ─── Settings & Host Orchestration ───────────────────────────────────────────

export function getExtensionPreinstallSettings(): ExtensionPreinstallSettings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const enabled = cfg.get<boolean>('preinstallExtensions.enabled', true);
  const rawList = cfg.get<unknown>('defaultExtensions', []);
  const defaultExtensions = Array.isArray(rawList)
    ? rawList.filter((item): item is string => typeof item === 'string')
    : [];
  const openVsxUrl = (cfg.get<string>('openVsxUrl', '') ?? '').trim();
  const vsixMirrorUrlTemplate = (cfg.get<string>('vsixMirrorUrlTemplate', '') ?? '').trim();

  return {
    enabled,
    defaultExtensions,
    openVsxUrl,
    vsixMirrorUrlTemplate,
  };
}

/**
 * Validate settings and derive the sanitized payload sent to the remote pod worker.
 */
export function buildSanitizedRemoteConfig(
  installResult: ServerInstallResult,
  settings: ExtensionPreinstallSettings
): RemoteInstallerConfig | undefined {
  const logger = Logger.getInstance();

  if (!settings.enabled) {
    logger.debug('Extension pre-installation is disabled via settings');
    return undefined;
  }

  const serverScript = installResult.serverScript;
  if (!SAFE_POSIX_PATH_RE.test(serverScript) || serverScript.includes('..')) {
    logger.warn(`Skipping extension pre-install: unsafe serverScript path '${serverScript}'`);
    return undefined;
  }

  const platform = SAFE_PLATFORM_RE.test(installResult.platform) ? installResult.platform : 'linux';
  const arch = SAFE_ARCH_RE.test(installResult.arch) ? installResult.arch : 'x64';

  // serverScript is `<serverDataDir>/bin/<commit>/bin/<serverAppName>`
  const serverBinDir = path.posix.dirname(serverScript);
  const serverDir = path.posix.dirname(serverBinDir);
  const serverDataDir = path.posix.dirname(path.posix.dirname(serverDir));

  if (
    !SAFE_POSIX_PATH_RE.test(serverDir) ||
    !SAFE_POSIX_PATH_RE.test(serverDataDir) ||
    serverDataDir === '/'
  ) {
    logger.warn(`Skipping extension pre-install: unexpected server directory layout '${serverScript}'`);
    return undefined;
  }

  const validExtensions: string[] = [];
  for (const entry of settings.defaultExtensions) {
    const parsed = parseExtensionEntry(entry);
    if (!parsed) {
      logger.warn(`Ignoring invalid extension entry in devspaces.defaultExtensions: '${entry}'`);
      continue;
    }
    validExtensions.push(entry.trim());
  }

  let openVsxUrl = '';
  if (settings.openVsxUrl) {
    if (settings.openVsxUrl.startsWith('https://') && isAllowedEndpointUrl(settings.openVsxUrl)) {
      openVsxUrl = settings.openVsxUrl.replace(/\/+$/, '');
    } else {
      logger.warn(
        `Ignoring devspaces.openVsxUrl '${settings.openVsxUrl}': must be a valid https:// URL`
      );
    }
  }

  let vsixMirrorUrlTemplate = '';
  if (settings.vsixMirrorUrlTemplate) {
    if (isValidVsixMirrorTemplate(settings.vsixMirrorUrlTemplate)) {
      vsixMirrorUrlTemplate = settings.vsixMirrorUrlTemplate;
    } else {
      logger.warn(
        'Ignoring devspaces.vsixMirrorUrlTemplate: must be a valid https:// URL template using only ${publisher}, ${name}, ${version}'
      );
    }
  }

  return {
    serverScript,
    serverDir,
    serverDataDir,
    platform,
    arch,
    projectsRoot: PROJECTS_ROOT,
    defaultExtensions: validExtensions,
    openVsxUrl,
    vsixMirrorUrlTemplate,
  };
}

/**
 * Build the self-contained CommonJS script executed by `$SERVER_DIR/node` inside the pod.
 *
 * When invoked with `--spawn-detached`, it spawns a detached background worker
 * (`setsid` via `detached: true` with stdio redirected to `.extensions-install.log`)
 * and exits immediately so the K8s exec WebSocket returns with near-zero latency.
 */
export function buildRemoteInstallerScript(config: RemoteInstallerConfig): string {
  const encodedConfig = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  return [
    `'use strict';`,
    `const CONFIG = JSON.parse(Buffer.from(${JSON.stringify(encodedConfig)}, 'base64').toString('utf8'));`,
    `const RUNNER = ${remoteInstallerMain.toString()};`,
    `if (process.argv.includes('--spawn-detached')) {`,
    `  const fs = require('fs');`,
    `  const path = require('path');`,
    `  const cp = require('child_process');`,
    `  fs.mkdirSync(CONFIG.serverDataDir, { recursive: true });`,
    `  const logPath = path.join(CONFIG.serverDataDir, '.extensions-install.log');`,
    `  const logFd = fs.openSync(logPath, 'a', 0o600);`,
    `  const env = Object.assign({}, process.env);`,
    `  const caBundle = '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem';`,
    `  if (!env.NODE_EXTRA_CA_CERTS && fs.existsSync(caBundle)) {`,
    `    env.NODE_EXTRA_CA_CERTS = caBundle;`,
    `  }`,
    `  const child = cp.spawn(process.execPath, [__filename, '--worker'], {`,
    `    detached: true,`,
    `    stdio: ['ignore', logFd, logFd],`,
    `    env,`,
    `  });`,
    `  child.unref();`,
    `  fs.closeSync(logFd);`,
    `  process.exit(0);`,
    `} else {`,
    `  RUNNER(CONFIG).catch((err) => {`,
    `    console.error('[devspaces-ext-installer] Fatal error:', err && err.stack ? err.stack : err);`,
    `    process.exitCode = 1;`,
    `  });`,
    `}`,
    ``,
  ].join('\n');
}

/**
 * Trigger non-blocking background extension pre-installation in the workspace pod.
 */
export async function triggerBackgroundExtensionInstall(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  installResult: ServerInstallResult
): Promise<void> {
  const logger = Logger.getInstance();
  const settings = getExtensionPreinstallSettings();
  const remoteConfig = buildSanitizedRemoteConfig(installResult, settings);
  if (!remoteConfig) {
    return;
  }

  const scriptContent = buildRemoteInstallerScript(remoteConfig);
  const installerPath = path.posix.join(remoteConfig.serverDataDir, '.devspaces-ext-installer.cjs');
  const nodeBin = path.posix.join(remoteConfig.serverDir, 'node');

  const exec = new k8s.Exec(kubeConfig);
  const stdinStream = stream.Readable.from([Buffer.from(scriptContent, 'utf8')]);
  let stderr = '';

  const stdoutStream = new stream.Writable({
    write(_chunk, _encoding, callback) {
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
    exec
      .exec(
        namespace,
        podName,
        containerName,
        [
          'sh',
          '-c',
          'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1.tmp" && mv "$1.tmp" "$1" && [ -x "$2" ] && "$2" "$1" --spawn-detached',
          'sh',
          installerPath,
          nodeBin,
        ],
        stdoutStream,
        stderrStream,
        stdinStream,
        false,
        (status: k8s.V1Status) => {
          if (status.status === 'Success') {
            resolve();
          } else {
            reject(new Error(status.message ?? stderr.trim() ?? 'exec failed'));
          }
        }
      )
      .catch(reject);
  });

  logger.info(
    `Triggered background extension check on ${podName}/${containerName} (log: ${remoteConfig.serverDataDir}/.extensions-install.log)`
  );
}

// ─── Self-Contained Remote Worker ────────────────────────────────────────────

/**
 * Self-contained remote installer executed inside the workspace pod by REH's bundled `node`.
 *
 * IMPORTANT: This function MUST NOT reference any module-scope identifiers outside its body
 * because it is serialized via `remoteInstallerMain.toString()` for remote execution.
 */
export async function remoteInstallerMain(
  config: RemoteInstallerConfig,
  deps?: RemoteInstallerDeps
): Promise<RemoteInstallerSummary> {
  const fs = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const os = require('os') as typeof import('os');
  const https = require('https') as typeof import('https');
  const http = require('http') as typeof import('http');
  const crypto = require('crypto') as typeof import('crypto');
  const zlib = require('zlib') as typeof import('zlib');
  const cp = require('child_process') as typeof import('child_process');

  const MAX_JSON_BYTES = 2 * 1024 * 1024;
  const MAX_VSIX_BYTES = 250 * 1024 * 1024;
  const MAX_PKG_JSON_BYTES = 5 * 1024 * 1024;
  const MAX_EXTENSIONS = 64;
  const DOWNLOAD_CONCURRENCY = 4;
  const HTTP_TIMEOUT_MS = 30_000;
  const LOCK_STALE_MS = 10 * 60 * 1000;

  const log = deps?.log ?? ((msg: string) => {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  });

  const partRe = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
  const verRe = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;
  const inClusterSvcRe = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\.svc(?:\.cluster\.local)?)$/;

  function isAllowedUrl(rawUrl: string): boolean {
    if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.length > 2048) {
      return false;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }
    if (parsed.username || parsed.password || parsed.hash) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      !host ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]' ||
      host.startsWith('169.254.')
    ) {
      return false;
    }
    if (parsed.protocol === 'https:') {
      return true;
    }
    if (parsed.protocol === 'http:') {
      return inClusterSvcRe.test(host);
    }
    return false;
  }

  function parseSpec(raw: string): ParsedExtensionSpec | undefined {
    if (typeof raw !== 'string') {
      return undefined;
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 2048) {
      return undefined;
    }
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
      if (!isAllowedUrl(trimmed)) {
        return undefined;
      }
      try {
        const u = new URL(trimmed);
        if (u.pathname.toLowerCase().endsWith('.vsix')) {
          return { kind: 'url', url: trimmed };
        }
        const m = u.pathname.match(/\/api\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)(?:\/([a-zA-Z0-9._+-]+))?\/?$/);
        if (m) {
          return makeId(m[1], m[2], m[3] && m[3] !== 'latest' ? m[3] : undefined);
        }
      } catch {
        return undefined;
      }
      return undefined;
    }

    const body = trimmed.startsWith('open-vsx:') ? trimmed.slice(9) : trimmed;
    if (body.includes('/')) {
      const parts = body.split('/');
      if (parts.length === 2 || parts.length === 3) {
        return makeId(parts[0], parts[1], parts[2] && parts[2] !== 'latest' ? parts[2] : undefined);
      }
      return undefined;
    }

    const atIdx = body.indexOf('@');
    const idPart = atIdx >= 0 ? body.slice(0, atIdx) : body;
    const verPart = atIdx >= 0 ? body.slice(atIdx + 1) : undefined;
    const dotIdx = idPart.indexOf('.');
    if (dotIdx <= 0 || dotIdx === idPart.length - 1) {
      return undefined;
    }
    return makeId(
      idPart.slice(0, dotIdx),
      idPart.slice(dotIdx + 1),
      verPart && verPart !== 'latest' ? verPart : undefined
    );
  }

  function makeId(pub: string, name: string, ver?: string): ParsedExtensionSpec | undefined {
    if (!partRe.test(pub) || !partRe.test(name) || pub === '.' || pub === '..' || name === '.' || name === '..') {
      return undefined;
    }
    if (ver !== undefined && (!verRe.test(ver) || ver === '.' || ver === '..')) {
      return undefined;
    }
    const p = pub.toLowerCase();
    const n = name.toLowerCase();
    return { kind: 'id', id: `${p}.${n}`, publisher: p, name: n, version: ver };
  }

  function stripJsonc(text: string): unknown {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];
      if (inStr) {
        out += ch;
        if (esc) {
          esc = false;
        } else if (ch === '\\') {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        out += ch;
        continue;
      }
      if (ch === '/' && next === '/') {
        i += 1;
        while (i + 1 < text.length && text[i + 1] !== '\n') {
          i++;
        }
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
          i++;
        }
        i += 1;
        continue;
      }
      out += ch;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  }

  async function defaultFetchBuffer(
    initialUrl: string,
    timeoutMs: number,
    maxBytes: number
  ): Promise<{ statusCode: number; body: Buffer }> {
    let currentUrl = initialUrl;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!isAllowedUrl(currentUrl)) {
        throw new Error(`Blocked disallowed or non-HTTPS URL: ${currentUrl}`);
      }
      const parsed = new URL(currentUrl);
      const client = parsed.protocol === 'https:' ? https : http;

      const response = await new Promise<{
        statusCode: number;
        location?: string;
        body: Buffer;
      }>((resolve, reject) => {
        const req = client.get(
          currentUrl,
          {
            timeout: timeoutMs,
            headers: {
              Accept: 'application/json, application/octet-stream, */*',
              'User-Agent': 'devspaces-remote-connector',
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
              res.resume();
              const nextUrl = new URL(res.headers.location, currentUrl).toString();
              resolve({ statusCode: status, location: nextUrl, body: Buffer.alloc(0) });
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            res.on('data', (chunk: Buffer) => {
              total += chunk.length;
              if (total > maxBytes) {
                req.destroy(new Error(`Response exceeded max size of ${maxBytes} bytes`));
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => {
              resolve({ statusCode: status, body: Buffer.concat(chunks) });
            });
            res.on('error', reject);
          }
        );
        req.on('timeout', () => {
          req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${currentUrl}`));
        });
        req.on('error', reject);
      });

      if (response.location) {
        currentUrl = response.location;
        continue;
      }
      return { statusCode: response.statusCode, body: response.body };
    }
    throw new Error(`Too many redirects while fetching ${initialUrl}`);
  }

  const fetchBuf = deps?.fetchBuffer ?? defaultFetchBuffer;
  const execCli = deps?.execServerCli ?? ((serverScript: string, args: string[]) => {
    cp.execFileSync(serverScript, args, {
      timeout: 5 * 60 * 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  // Extract `extension/package.json` from a `.vsix` (ZIP) buffer in memory without shell/unzip
  function readVsixPackageJson(zipBuf: Buffer): Record<string, any> | undefined {
    // Locate End of Central Directory (EOCD) signature 0x06054b50 within last 65KB
    const minOffset = Math.max(0, zipBuf.length - 65557);
    let eocdOffset = -1;
    for (let i = zipBuf.length - 22; i >= minOffset; i--) {
      if (zipBuf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) {
      return undefined;
    }

    const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
    const cdSize = zipBuf.readUInt32LE(eocdOffset + 12);
    const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
    if (cdOffset + cdSize > zipBuf.length) {
      return undefined;
    }

    let ptr = cdOffset;
    for (let entry = 0; entry < totalEntries && ptr + 46 <= cdOffset + cdSize; entry++) {
      if (zipBuf.readUInt32LE(ptr) !== 0x02014b50) {
        break;
      }
      const compressionMethod = zipBuf.readUInt16LE(ptr + 10);
      const compressedSize = zipBuf.readUInt32LE(ptr + 20);
      const uncompressedSize = zipBuf.readUInt32LE(ptr + 24);
      const fileNameLen = zipBuf.readUInt16LE(ptr + 28);
      const extraLen = zipBuf.readUInt16LE(ptr + 30);
      const commentLen = zipBuf.readUInt16LE(ptr + 32);
      const localHeaderOffset = zipBuf.readUInt32LE(ptr + 42);

      const nameStart = ptr + 46;
      const nameEnd = nameStart + fileNameLen;
      if (nameEnd > zipBuf.length) {
        break;
      }
      const fileName = zipBuf.subarray(nameStart, nameEnd).toString('utf8');
      ptr = nameEnd + extraLen + commentLen;

      if (fileName.toLowerCase() !== 'extension/package.json') {
        continue;
      }
      if (uncompressedSize > MAX_PKG_JSON_BYTES || compressedSize > MAX_PKG_JSON_BYTES) {
        throw new Error('extension/package.json exceeds safe size limit');
      }
      if (localHeaderOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        return undefined;
      }
      const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > zipBuf.length) {
        return undefined;
      }

      const slice = zipBuf.subarray(dataStart, dataEnd);
      let rawJson: Buffer;
      if (compressionMethod === 0) {
        rawJson = slice;
      } else if (compressionMethod === 8) {
        rawJson = zlib.inflateRawSync(slice, { maxOutputLength: MAX_PKG_JSON_BYTES });
      } else {
        return undefined;
      }
      return stripJsonc(rawJson.toString('utf8')) as Record<string, any>;
    }
    return undefined;
  }

  // Acquire non-blocking lockfile so concurrent connects never race
  fs.mkdirSync(config.serverDataDir, { recursive: true });
  const lockPath = pathMod.join(config.serverDataDir, '.extensions-install.lock');
  if (fs.existsSync(lockPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number; timestamp?: number };
      const fresh = typeof existing.timestamp === 'number' && Date.now() - existing.timestamp < LOCK_STALE_MS;
      let alive = false;
      if (fresh && typeof existing.pid === 'number' && existing.pid !== process.pid) {
        try {
          process.kill(existing.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (fresh && alive) {
        log(`Another extension installer process (PID ${existing.pid}) is active; exiting.`);
        return { installedVsixCount: 0, skippedAlreadyInstalled: 0, failedExtensions: [] };
      }
      fs.unlinkSync(lockPath);
    } catch {
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }

  try {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
      { flag: 'wx', mode: 0o600 }
    );
  } catch {
    log('Lockfile acquired by concurrent installer; exiting.');
    return { installedVsixCount: 0, skippedAlreadyInstalled: 0, failedExtensions: [] };
  }

  let tempDir: string | undefined;
  try {
    // 1. Discover cluster CheCluster settings (openVSXURL, embedded plugin-registry, defaultPlugins)
    let clusterOpenVsxUrl = '';
    const embeddedRegistryBases: string[] = [];
    const clusterDefaultPlugins: string[] = [];

    const configUrls = deps?.serverConfigUrls ?? [
      'http://devspaces-dashboard.openshift-devspaces.svc:8080/dashboard/api/server-config',
      'http://che-dashboard.eclipse-che.svc:8080/dashboard/api/server-config',
    ];

    for (const cfgUrl of configUrls) {
      try {
        const res = await fetchBuf(cfgUrl, 3_000, MAX_JSON_BYTES);
        if (res.statusCode !== 200) {
          continue;
        }
        const sc = JSON.parse(res.body.toString('utf8')) as Record<string, any>;
        const ovsx = typeof sc?.pluginRegistry?.openVSXURL === 'string'
          ? sc.pluginRegistry.openVSXURL.trim()
          : '';
        if (ovsx && isAllowedUrl(ovsx)) {
          clusterOpenVsxUrl = ovsx.replace(/\/+$/, '');
        }
        for (const regField of [sc?.pluginRegistryInternalURL, sc?.pluginRegistryURL]) {
          if (typeof regField === 'string' && regField.trim()) {
            const normalized = regField.trim().replace(/\/v3\/?$/, '/openvsx/api').replace(/\/+$/, '');
            if (isAllowedUrl(normalized) && !embeddedRegistryBases.includes(normalized)) {
              embeddedRegistryBases.push(normalized);
            }
          }
        }
        const defPlugins = sc?.defaults?.plugins;
        if (Array.isArray(defPlugins)) {
          for (const item of defPlugins) {
            if (typeof item === 'string') {
              clusterDefaultPlugins.push(item);
            } else if (item && Array.isArray(item.plugins)) {
              for (const p of item.plugins) {
                if (typeof p === 'string') {
                  clusterDefaultPlugins.push(p);
                }
              }
            }
          }
        }
        break;
      } catch {
        // Not reachable in this namespace/topology — continue cleanly
      }
    }

    // 2. Discover workspace `.vscode/extensions.json` recommendations
    const workspaceRecommendations: string[] = [];
    const unwantedSet = new Set<string>();
    const candidateFiles = new Set<string>();

    const envProjectSource = process.env.PROJECT_SOURCE;
    if (envProjectSource && envProjectSource.startsWith('/')) {
      candidateFiles.add(pathMod.join(envProjectSource, '.vscode', 'extensions.json'));
    }
    const projectsRoot = config.projectsRoot || '/projects';
    if (fs.existsSync(projectsRoot)) {
      candidateFiles.add(pathMod.join(projectsRoot, '.vscode', 'extensions.json'));
      try {
        for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            candidateFiles.add(pathMod.join(projectsRoot, entry.name, '.vscode', 'extensions.json'));
          }
        }
      } catch {
        // Ignore unreadable directories
      }
    }

    for (const extJsonPath of candidateFiles) {
      try {
        if (!fs.existsSync(extJsonPath)) {
          continue;
        }
        const stat = fs.lstatSync(extJsonPath);
        if (!stat.isFile() || stat.size > 256 * 1024) {
          continue;
        }
        const parsed = stripJsonc(fs.readFileSync(extJsonPath, 'utf8')) as Record<string, any>;
        if (Array.isArray(parsed?.unwantedRecommendations)) {
          for (const u of parsed.unwantedRecommendations) {
            const spec = parseSpec(u);
            if (spec?.kind === 'id' && spec.id) {
              unwantedSet.add(spec.id);
            }
          }
        }
        if (Array.isArray(parsed?.recommendations)) {
          for (const r of parsed.recommendations) {
            if (typeof r === 'string') {
              workspaceRecommendations.push(r);
            }
          }
        }
      } catch (err) {
        log(`Skipping malformed ${extJsonPath}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 3. Merge & deduplicate desired extensions
    const desiredSpecs: ParsedExtensionSpec[] = [];
    const seenIds = new Map<string, ParsedExtensionSpec>();
    const seenUrls = new Set<string>();

    const addCandidate = (raw: string, respectUnwanted: boolean) => {
      const spec = parseSpec(raw);
      if (!spec) {
        return;
      }
      if (spec.kind === 'url' && spec.url) {
        if (!seenUrls.has(spec.url)) {
          seenUrls.add(spec.url);
          desiredSpecs.push(spec);
        }
        return;
      }
      if (spec.kind === 'id' && spec.id) {
        if (respectUnwanted && unwantedSet.has(spec.id)) {
          return;
        }
        const existing = seenIds.get(spec.id);
        if (!existing) {
          seenIds.set(spec.id, spec);
          desiredSpecs.push(spec);
        } else if (!existing.version && spec.version) {
          existing.version = spec.version;
        }
      }
    };

    for (const raw of config.defaultExtensions) { addCandidate(raw, false); }
    for (const raw of clusterDefaultPlugins) { addCandidate(raw, false); }
    for (const raw of workspaceRecommendations) { addCandidate(raw, true); }

    if (desiredSpecs.length === 0) {
      log('No configured or recommended workspace extensions found.');
      return { installedVsixCount: 0, skippedAlreadyInstalled: 0, failedExtensions: [] };
    }

    // 4. Inspect already-installed extensions (user extensions + built-in REH extensions)
    const installedVersions = new Map<string, Set<string>>();
    const recordInstalled = (idLower: string, ver: string) => {
      let set = installedVersions.get(idLower);
      if (!set) {
        set = new Set<string>();
        installedVersions.set(idLower, set);
      }
      set.add(ver);
    };

    const scanExtensionsDir = (dirPath: string) => {
      if (!fs.existsSync(dirPath)) {
        return;
      }
      const registryJson = pathMod.join(dirPath, 'extensions.json');
      if (fs.existsSync(registryJson)) {
        try {
          const entries = JSON.parse(fs.readFileSync(registryJson, 'utf8'));
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const id = typeof entry?.identifier?.id === 'string' ? entry.identifier.id.toLowerCase() : '';
              const ver = typeof entry?.version === 'string' ? entry.version : '';
              const rel = typeof entry?.relativeLocation === 'string' ? entry.relativeLocation : '';
              if (id && ver && (!rel || fs.existsSync(pathMod.join(dirPath, rel)))) {
                recordInstalled(id, ver);
              }
            }
          }
        } catch {
          // Fall back to directory scan below
        }
      }
      try {
        for (const dirent of fs.readdirSync(dirPath, { withFileTypes: true })) {
          if (!dirent.isDirectory() || dirent.name.startsWith('.')) {
            continue;
          }
          const pkgFile = pathMod.join(dirPath, dirent.name, 'package.json');
          if (!fs.existsSync(pkgFile)) {
            continue;
          }
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
            if (typeof pkg?.publisher === 'string' && typeof pkg?.name === 'string') {
              recordInstalled(
                `${pkg.publisher.toLowerCase()}.${pkg.name.toLowerCase()}`,
                typeof pkg.version === 'string' ? pkg.version : '*'
              );
            }
          } catch {
            // Ignore unreadable package.json
          }
        }
      } catch {
        // Ignore unreadable extensions dir
      }
    };

    scanExtensionsDir(pathMod.join(config.serverDir, 'extensions'));
    scanExtensionsDir(pathMod.join(config.serverDataDir, 'extensions'));

    const isInstalled = (idLower: string, version?: string): boolean => {
      if (idLower.startsWith('vscode.')) {
        return true; // Built-in VS Code API extensions
      }
      const versions = installedVersions.get(idLower);
      if (!versions || versions.size === 0) {
        return false;
      }
      return version ? versions.has(version) : true;
    };

    // Filter to missing extensions
    let skippedAlreadyInstalled = 0;
    const queue: ParsedExtensionSpec[] = [];
    for (const spec of desiredSpecs) {
      if (spec.kind === 'id' && spec.id && isInstalled(spec.id, spec.version)) {
        skippedAlreadyInstalled++;
        continue;
      }
      queue.push(spec);
    }

    if (queue.length === 0) {
      log(`All ${skippedAlreadyInstalled} desired extension(s) are already installed.`);
      return { installedVsixCount: 0, skippedAlreadyInstalled, failedExtensions: [] };
    }

    // Build ordered list of OpenVSX base URLs to try
    const openVsxBases: string[] = [];
    if (config.openVsxUrl) {
      openVsxBases.push(config.openVsxUrl);
    }
    if (clusterOpenVsxUrl && !openVsxBases.includes(clusterOpenVsxUrl)) {
      openVsxBases.push(clusterOpenVsxUrl);
    }
    for (const emb of embeddedRegistryBases) {
      if (!openVsxBases.includes(emb)) {
        openVsxBases.push(emb);
      }
    }

    // Rewrite baked-in `https://plugin-registry.<ns>.svc:8080/plugin-registry/...` URLs
    // returned by Dev Spaces' static internal OpenVSX JSON metadata so they match the
    // actual ClusterIP HTTP endpoint (`http://plugin-registry.<ns>.svc:8080/...`).
    function normalizeRegistryAssetUrl(assetUrl: string, apiBaseUrl: string): string {
      try {
        const asset = new URL(assetUrl);
        const base = new URL(apiBaseUrl);
        if (
          inClusterSvcRe.test(asset.hostname.toLowerCase()) &&
          asset.hostname.toLowerCase() === base.hostname.toLowerCase()
        ) {
          asset.protocol = base.protocol;
          asset.port = base.port;
          if (asset.pathname.startsWith('/plugin-registry/') && !base.pathname.startsWith('/plugin-registry/')) {
            asset.pathname = asset.pathname.slice('/plugin-registry'.length);
          }
          return asset.toString();
        }
      } catch {
        // Keep original URL and let isAllowedUrl validate it
      }
      return assetUrl;
    }

    async function queryOpenVsxMetadata(
      publisher: string,
      name: string,
      version?: string
    ): Promise<{ downloadUrl: string; sha256Url?: string; resolvedVersion?: string } | undefined> {
      const targetKey = `${config.platform}-${config.arch}`;
      const suffix = version ? `${publisher}/${name}/${version}` : `${publisher}/${name}`;

      for (const base of openVsxBases) {
        const candidateApiUrls = base.endsWith('/api')
          ? [`${base}/${suffix}`]
          : [`${base}/api/${suffix}`, `${base}/${suffix}`];

        for (const metaUrl of candidateApiUrls) {
          try {
            const res = await fetchBuf(metaUrl, HTTP_TIMEOUT_MS, MAX_JSON_BYTES);
            if (res.statusCode !== 200) {
              continue;
            }
            const meta = JSON.parse(res.body.toString('utf8')) as Record<string, any>;
            if (meta?.error) {
              continue;
            }
            const downloads = meta?.downloads as Record<string, string> | undefined;
            const filesDownload = typeof meta?.files?.download === 'string' ? meta.files.download : '';
            const rawDownload =
              (downloads && typeof downloads[targetKey] === 'string' && downloads[targetKey]) ||
              (downloads && typeof downloads.universal === 'string' && downloads.universal) ||
              filesDownload;

            if (!rawDownload) {
              continue;
            }
            const downloadUrl = normalizeRegistryAssetUrl(rawDownload, metaUrl);
            if (!isAllowedUrl(downloadUrl)) {
              continue;
            }
            let sha256Url: string | undefined;
            if (rawDownload === filesDownload && typeof meta?.files?.sha256 === 'string') {
              const normalizedSha = normalizeRegistryAssetUrl(meta.files.sha256, metaUrl);
              if (isAllowedUrl(normalizedSha)) {
                sha256Url = normalizedSha;
              }
            }
            const resolvedVersion = typeof meta?.version === 'string' && verRe.test(meta.version)
              ? meta.version
              : version;
            return { downloadUrl, sha256Url, resolvedVersion };
          } catch {
            // Try next candidate URL / registry
          }
        }
      }
      return undefined;
    }

    async function resolveDownloadTarget(
      spec: ParsedExtensionSpec
    ): Promise<{ downloadUrl: string; sha256Url?: string; label: string }> {
      if (spec.kind === 'url' && spec.url) {
        return { downloadUrl: spec.url, label: spec.url };
      }
      const pub = spec.publisher!;
      const name = spec.name!;
      const label = spec.version ? `${pub}.${name}@${spec.version}` : `${pub}.${name}`;

      if (config.vsixMirrorUrlTemplate) {
        let ver = spec.version;
        if (!ver && config.vsixMirrorUrlTemplate.includes('${version}')) {
          const meta = await queryOpenVsxMetadata(pub, name, undefined);
          ver = meta?.resolvedVersion;
        }
        if (ver || !config.vsixMirrorUrlTemplate.includes('${version}')) {
          const templated = config.vsixMirrorUrlTemplate
            .replace(/\$\{publisher\}/g, pub)
            .replace(/\$\{name\}/g, name)
            .replace(/\$\{version\}/g, ver ?? 'latest');
          if (isAllowedUrl(templated)) {
            return { downloadUrl: templated, label };
          }
        }
      }

      const ovsx = await queryOpenVsxMetadata(pub, name, spec.version);
      if (ovsx) {
        return { downloadUrl: ovsx.downloadUrl, sha256Url: ovsx.sha256Url, label };
      }

      throw new Error(
        `Could not resolve VSIX download URL for '${label}' from configured registries (${openVsxBases.length > 0 ? openVsxBases.join(', ') : 'none'})`
      );
    }

    // 5. Download VSIXs + recursively resolve `extensionDependencies` & `extensionPack`
    tempDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'devspaces-vsix-'));
    fs.chmodSync(tempDir, 0o700);

    const processedKeys = new Set<string>();
    const downloadedFiles: Array<{ label: string; filePath: string }> = [];
    const failedExtensions: string[] = [];
    let fileCounter = 0;

    for (const item of queue) {
      if (item.kind === 'id' && item.id) {
        processedKeys.add(item.id);
      } else if (item.kind === 'url' && item.url) {
        processedKeys.add(item.url);
      }
    }

    while (queue.length > 0 && downloadedFiles.length < MAX_EXTENSIONS) {
      const batch = queue.splice(0, Math.min(DOWNLOAD_CONCURRENCY, MAX_EXTENSIONS - downloadedFiles.length));
      const batchResults = await Promise.all(
        batch.map(async (spec) => {
          const fallbackLabel = spec.kind === 'url'
            ? (spec.url ?? 'url')
            : (spec.version ? `${spec.id}@${spec.version}` : (spec.id ?? 'unknown'));
          try {
            const target = await resolveDownloadTarget(spec);
            const res = await fetchBuf(target.downloadUrl, HTTP_TIMEOUT_MS, MAX_VSIX_BYTES);
            if (res.statusCode !== 200) {
              throw new Error(`HTTP ${res.statusCode} downloading ${target.downloadUrl}`);
            }

            if (target.sha256Url) {
              const shaRes = await fetchBuf(target.sha256Url, HTTP_TIMEOUT_MS, 4096);
              if (shaRes.statusCode === 200) {
                const expectedMatch = shaRes.body.toString('utf8').trim().match(/^[a-fA-F0-9]{64}/);
                if (expectedMatch) {
                  const actualHex = crypto.createHash('sha256').update(res.body).digest('hex');
                  if (actualHex.toLowerCase() !== expectedMatch[0].toLowerCase()) {
                    throw new Error(
                      `SHA-256 mismatch for ${target.label}: expected ${expectedMatch[0]}, got ${actualHex}`
                    );
                  }
                }
              }
            }

            const pkg = readVsixPackageJson(res.body);
            if (pkg && typeof pkg.publisher === 'string' && typeof pkg.name === 'string') {
              const actualId = `${pkg.publisher.toLowerCase()}.${pkg.name.toLowerCase()}`;
              const actualVer = typeof pkg.version === 'string' ? pkg.version : undefined;
              if (spec.kind === 'url' && isInstalled(actualId, actualVer)) {
                skippedAlreadyInstalled++;
                return undefined;
              }
              processedKeys.add(actualId);
            }

            const idx = fileCounter++;
            const vsixPath = pathMod.join(tempDir!, `ext-${idx}.vsix`);
            fs.writeFileSync(vsixPath, res.body, { mode: 0o600 });

            const depsList: string[] = [];
            if (Array.isArray(pkg?.extensionDependencies)) {
              for (const d of pkg.extensionDependencies) {
                if (typeof d === 'string') { depsList.push(d); }
              }
            }
            if (Array.isArray(pkg?.extensionPack)) {
              for (const p of pkg.extensionPack) {
                if (typeof p === 'string') { depsList.push(p); }
              }
            }

            return { label: target.label, filePath: vsixPath, depsList };
          } catch (err) {
            log(`Failed to prepare ${fallbackLabel}: ${err instanceof Error ? err.message : err}`);
            failedExtensions.push(fallbackLabel);
            return undefined;
          }
        })
      );

      for (const item of batchResults) {
        if (!item) {
          continue;
        }
        downloadedFiles.push({ label: item.label, filePath: item.filePath });
        for (const depRaw of item.depsList) {
          const depSpec = parseSpec(depRaw);
          if (!depSpec || depSpec.kind !== 'id' || !depSpec.id) {
            continue;
          }
          if (isInstalled(depSpec.id, depSpec.version) || processedKeys.has(depSpec.id)) {
            continue;
          }
          processedKeys.add(depSpec.id);
          queue.push(depSpec);
        }
      }
    }

    if (downloadedFiles.length === 0) {
      return { installedVsixCount: 0, skippedAlreadyInstalled, failedExtensions };
    }

    // Install dependencies before dependents by reversing BFS discovery order
    const orderedFiles = [...downloadedFiles].reverse();
    const batchArgs: string[] = [];
    for (const f of orderedFiles) {
      batchArgs.push('--install-extension', f.filePath);
    }
    batchArgs.push('--do-not-include-pack-dependencies');

    log(
      `Installing ${orderedFiles.length} extension VSIX(s) via local batch extract: ${orderedFiles.map((f) => f.label).join(', ')}`
    );

    let installedVsixCount = 0;
    try {
      execCli(config.serverScript, batchArgs);
      installedVsixCount = orderedFiles.length;
      log(`Successfully installed ${installedVsixCount} extension(s).`);
    } catch (batchErr) {
      log(
        `Batch install returned an error (${batchErr instanceof Error ? batchErr.message : batchErr}); retrying individually...`
      );
      for (const f of orderedFiles) {
        try {
          execCli(config.serverScript, [
            '--install-extension',
            f.filePath,
            '--do-not-include-pack-dependencies',
          ]);
          installedVsixCount++;
          log(`Installed ${f.label}`);
        } catch (singleErr) {
          log(`Failed to install ${f.label}: ${singleErr instanceof Error ? singleErr.message : singleErr}`);
          failedExtensions.push(f.label);
        }
      }
    }

    return { installedVsixCount, skippedAlreadyInstalled, failedExtensions };
  } finally {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore temp cleanup failure
      }
    }
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Ignore lock cleanup failure
    }
  }
}
