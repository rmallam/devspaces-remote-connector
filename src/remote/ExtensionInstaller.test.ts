import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import * as cp from 'child_process';
import {
  isAllowedEndpointUrl,
  isValidVsixMirrorTemplate,
  parseExtensionEntry,
  parseJsonc,
  buildSanitizedRemoteConfig,
  buildRemoteInstallerScript,
  remoteInstallerMain,
  RemoteInstallerConfig,
} from './ExtensionInstaller';

jest.mock('../util/Logger', () => ({
  Logger: {
    getInstance: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
}));

/**
 * Helper: construct a minimal valid ZIP (.vsix) buffer containing `extension/package.json`
 * compressed with Deflate (method 8) so tests exercise real binary ZIP parsing.
 */
function createMockVsixBuffer(packageJson: Record<string, unknown>): Buffer {
  const fileName = Buffer.from('extension/package.json', 'utf8');
  const uncompressed = Buffer.from(JSON.stringify(packageJson), 'utf8');
  const compressed = zlib.deflateRawSync(uncompressed);

  // CRC32 calculation
  let crc = 0xffffffff;
  for (let i = 0; i < uncompressed.length; i++) {
    crc ^= uncompressed[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  // Local file header (30 bytes + filename)
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // signature
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(8, 8); // compression = deflate
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(uncompressed.length, 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra len

  const cdOffset = localHeader.length + fileName.length + compressed.length;

  // Central directory header (46 bytes + filename)
  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0); // signature
  cdHeader.writeUInt16LE(20, 4); // version made by
  cdHeader.writeUInt16LE(20, 6); // version needed
  cdHeader.writeUInt16LE(0, 8); // flags
  cdHeader.writeUInt16LE(8, 10); // compression = deflate
  cdHeader.writeUInt16LE(0, 12);
  cdHeader.writeUInt16LE(0, 14);
  cdHeader.writeUInt32LE(crc, 16);
  cdHeader.writeUInt32LE(compressed.length, 20);
  cdHeader.writeUInt32LE(uncompressed.length, 24);
  cdHeader.writeUInt16LE(fileName.length, 28);
  cdHeader.writeUInt16LE(0, 30); // extra
  cdHeader.writeUInt16LE(0, 32); // comment
  cdHeader.writeUInt16LE(0, 34); // disk start
  cdHeader.writeUInt16LE(0, 36); // internal attrs
  cdHeader.writeUInt32LE(0, 38); // external attrs
  cdHeader.writeUInt32LE(0, 42); // local header offset = 0

  const cdSize = cdHeader.length + fileName.length;

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); // entries on disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, fileName, compressed, cdHeader, fileName, eocd]);
}

describe('ExtensionInstaller', () => {
  describe('URL & Input Security Validation', () => {
    it('allows HTTPS URLs on external hosts and rejects plain HTTP on external hosts', () => {
      expect(isAllowedEndpointUrl('https://artifactory.corp.example.com/artifactory/api/openvsx/vscode')).toBe(true);
      expect(isAllowedEndpointUrl('https://open-vsx.org/api/redhat/vscode-yaml')).toBe(true);
      expect(isAllowedEndpointUrl('http://artifactory.corp.example.com/artifactory/vscode.vsix')).toBe(false);
      expect(isAllowedEndpointUrl('http://open-vsx.org/api/redhat/vscode-yaml')).toBe(false);
    });

    it('allows plain HTTP only for Kubernetes in-cluster .svc endpoints', () => {
      expect(
        isAllowedEndpointUrl('http://devspaces-dashboard.openshift-devspaces.svc:8080/dashboard/api/server-config')
      ).toBe(true);
      expect(
        isAllowedEndpointUrl('http://plugin-registry.openshift-devspaces.svc:8080/openvsx/api')
      ).toBe(true);
      expect(
        isAllowedEndpointUrl('http://plugin-registry.openshift-devspaces.svc.cluster.local:8080/openvsx/api')
      ).toBe(true);
    });

    it('rejects localhost, link-local metadata IPs, embedded credentials, and non-HTTP schemes', () => {
      expect(isAllowedEndpointUrl('https://localhost:8443/ext.vsix')).toBe(false);
      expect(isAllowedEndpointUrl('https://127.0.0.1/ext.vsix')).toBe(false);
      expect(isAllowedEndpointUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
      expect(isAllowedEndpointUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
      expect(isAllowedEndpointUrl('https://user:secret@artifactory.example.com/ext.vsix')).toBe(false);
      expect(isAllowedEndpointUrl('file:///etc/passwd')).toBe(false);
      expect(isAllowedEndpointUrl('https://artifactory.example.com/ext.vsix#fragment')).toBe(false);
    });

    it('validates VSIX mirror URL templates strictly', () => {
      expect(
        isValidVsixMirrorTemplate(
          'https://artifactory.example.com/vscode/${publisher}/${name}/${publisher}.${name}-${version}.vsix'
        )
      ).toBe(true);
      expect(
        isValidVsixMirrorTemplate('http://artifactory.example.com/vscode/${publisher}.${name}.vsix')
      ).toBe(false);
      expect(
        isValidVsixMirrorTemplate('https://artifactory.example.com/vscode/${evil}/${name}.vsix')
      ).toBe(false);
      expect(
        isValidVsixMirrorTemplate('https://artifactory.example.com/vscode/`whoami`/${name}.vsix')
      ).toBe(false);
    });

    it('parses valid extension formats and rejects injection / traversal attempts', () => {
      expect(parseExtensionEntry('RedHat.vscode-yaml')).toEqual({
        kind: 'id',
        id: 'redhat.vscode-yaml',
        publisher: 'redhat',
        name: 'vscode-yaml',
        version: undefined,
      });
      expect(parseExtensionEntry('redhat.vscode-yaml@1.24.0')).toEqual({
        kind: 'id',
        id: 'redhat.vscode-yaml',
        publisher: 'redhat',
        name: 'vscode-yaml',
        version: '1.24.0',
      });
      expect(parseExtensionEntry('open-vsx:redhat/vscode-openshift-connector/0.25.0')).toEqual({
        kind: 'id',
        id: 'redhat.vscode-openshift-connector',
        publisher: 'redhat',
        name: 'vscode-openshift-connector',
        version: '0.25.0',
      });
      expect(parseExtensionEntry('redhat/vscode-yaml/latest')).toEqual({
        kind: 'id',
        id: 'redhat.vscode-yaml',
        publisher: 'redhat',
        name: 'vscode-yaml',
        version: undefined,
      });
      expect(parseExtensionEntry('https://open-vsx.org/api/redhat/vscode-yaml/1.24.0')).toEqual({
        kind: 'id',
        id: 'redhat.vscode-yaml',
        publisher: 'redhat',
        name: 'vscode-yaml',
        version: '1.24.0',
      });
      expect(parseExtensionEntry('https://artifactory.example.com/generic/custom-1.0.0.vsix')).toEqual({
        kind: 'url',
        url: 'https://artifactory.example.com/generic/custom-1.0.0.vsix',
      });

      // Malicious / malformed inputs
      expect(parseExtensionEntry('redhat.vscode-yaml; rm -rf /')).toBeUndefined();
      expect(parseExtensionEntry('$(touch /tmp/pwn).ext')).toBeUndefined();
      expect(parseExtensionEntry('../etc/passwd')).toBeUndefined();
      expect(parseExtensionEntry('redhat.vscode-yaml@../../evil')).toBeUndefined();
      expect(parseExtensionEntry('http://evil.example.com/bad.vsix')).toBeUndefined();
    });

    it('sanitizes remote installer config and rejects unsafe serverScript paths', () => {
      const bad = buildSanitizedRemoteConfig(
        {
          connectionToken: 'tok',
          serverScript: '/home/user/.vscode-server/bin/abc/../../evil;sh',
          listeningOn: 12345,
          platform: 'linux',
          arch: 'x64',
        },
        {
          enabled: true,
          defaultExtensions: ['redhat.vscode-yaml'],
          openVsxUrl: '',
          vsixMirrorUrlTemplate: '',
        }
      );
      expect(bad).toBeUndefined();

      const good = buildSanitizedRemoteConfig(
        {
          connectionToken: 'tok',
          serverScript: '/home/user/.vscode-server/bin/c4453f8ea/bin/code-server',
          listeningOn: 12345,
          platform: 'linux',
          arch: 'x64',
        },
        {
          enabled: true,
          defaultExtensions: ['redhat.vscode-yaml', 'bad;entry'],
          openVsxUrl: 'http://insecure.example.com/ovsx',
          vsixMirrorUrlTemplate: 'https://artifactory.example.com/vsix/${publisher}.${name}.vsix',
        }
      );
      expect(good).toEqual({
        serverScript: '/home/user/.vscode-server/bin/c4453f8ea/bin/code-server',
        serverDir: '/home/user/.vscode-server/bin/c4453f8ea',
        serverDataDir: '/home/user/.vscode-server',
        platform: 'linux',
        arch: 'x64',
        projectsRoot: '/projects',
        defaultExtensions: ['redhat.vscode-yaml'],
        openVsxUrl: '',
        vsixMirrorUrlTemplate: 'https://artifactory.example.com/vsix/${publisher}.${name}.vsix',
      });
    });
  });

  describe('parseJsonc', () => {
    it('strips line comments, block comments, and trailing commas while preserving URLs in strings', () => {
      const raw = `{
        // Workspace recommended extensions
        "recommendations": [
          "redhat.vscode-yaml", /* YAML support */
          "https://artifactory.example.com/ext/my-tool.vsix",
        ],
        "unwantedRecommendations": [
          "ms-vscode.powershell",
        ],
      }`;
      expect(parseJsonc(raw)).toEqual({
        recommendations: [
          'redhat.vscode-yaml',
          'https://artifactory.example.com/ext/my-tool.vsix',
        ],
        unwantedRecommendations: ['ms-vscode.powershell'],
      });
    });
  });

  describe('remoteInstallerMain', () => {
    let tmpRoot: string;
    let baseConfig: RemoteInstallerConfig;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-inst-test-'));
      const serverDataDir = path.join(tmpRoot, '.vscode-server');
      const serverDir = path.join(serverDataDir, 'bin', 'commit123');
      const projectsRoot = path.join(tmpRoot, 'projects');
      fs.mkdirSync(path.join(serverDir, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(serverDir, 'extensions'), { recursive: true });
      fs.mkdirSync(path.join(serverDataDir, 'extensions'), { recursive: true });
      fs.mkdirSync(projectsRoot, { recursive: true });

      baseConfig = {
        serverScript: path.join(serverDir, 'bin', 'code-server'),
        serverDir,
        serverDataDir,
        platform: 'linux',
        arch: 'x64',
        projectsRoot,
        defaultExtensions: [],
        openVsxUrl: '',
        vsixMirrorUrlTemplate: '',
      };
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('discovers CheCluster + .vscode/extensions.json, rewrites embedded registry URLs, verifies SHA-256, resolves dependencies, and installs in one batch', async () => {
      // Create workspace repo with .vscode/extensions.json
      const repoVscode = path.join(baseConfig.projectsRoot, 'demo-app', '.vscode');
      fs.mkdirSync(repoVscode, { recursive: true });
      fs.writeFileSync(
        path.join(repoVscode, 'extensions.json'),
        `{
          // Recommended for this repo
          "recommendations": ["redhat.vscode-openshift-connector", "ms-vscode.unwanted"],
          "unwantedRecommendations": ["ms-vscode.unwanted"],
        }`
      );

      // Build mock VSIXs: openshift-connector depends on redhat.vscode-yaml + built-in vscode.git
      const openshiftVsix = createMockVsixBuffer({
        publisher: 'redhat',
        name: 'vscode-openshift-connector',
        version: '0.25.0',
        extensionDependencies: ['redhat.vscode-yaml', 'vscode.git'],
      });
      const yamlVsix = createMockVsixBuffer({
        publisher: 'redhat',
        name: 'vscode-yaml',
        version: '1.24.0',
      });
      const yamlSha = crypto.createHash('sha256').update(yamlVsix).digest('hex');

      const cliCalls: Array<{ script: string; args: string[] }> = [];

      const summary = await remoteInstallerMain(baseConfig, {
        log: () => {},
        execServerCli: (script, args) => {
          // Verify VSIX files actually exist on disk at invocation time
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '--install-extension') {
              expect(fs.existsSync(args[i + 1])).toBe(true);
            }
          }
          cliCalls.push({ script, args });
        },
        fetchBuffer: async (url) => {
          if (url === 'http://devspaces-dashboard.openshift-devspaces.svc:8080/dashboard/api/server-config') {
            return {
              statusCode: 200,
              body: Buffer.from(
                JSON.stringify({
                  pluginRegistry: { openVSXURL: '' },
                  pluginRegistryInternalURL: 'http://plugin-registry.openshift-devspaces.svc:8080/v3',
                  defaults: { plugins: [] },
                })
              ),
            };
          }
          if (url === 'http://plugin-registry.openshift-devspaces.svc:8080/openvsx/api/redhat/vscode-openshift-connector') {
            return {
              statusCode: 200,
              body: Buffer.from(
                JSON.stringify({
                  version: '0.25.0',
                  // Simulates Dev Spaces 3.31 baked-in static metadata URL quirk
                  files: {
                    download:
                      'https://plugin-registry.openshift-devspaces.svc:8080/plugin-registry/openvsx/api/redhat/vscode-openshift-connector/0.25.0/file/openshift.vsix',
                  },
                })
              ),
            };
          }
          if (
            url ===
            'http://plugin-registry.openshift-devspaces.svc:8080/openvsx/api/redhat/vscode-openshift-connector/0.25.0/file/openshift.vsix'
          ) {
            return { statusCode: 200, body: openshiftVsix };
          }
          if (url === 'http://plugin-registry.openshift-devspaces.svc:8080/openvsx/api/redhat/vscode-yaml') {
            return {
              statusCode: 200,
              body: Buffer.from(
                JSON.stringify({
                  version: '1.24.0',
                  files: {
                    download:
                      'https://plugin-registry.openshift-devspaces.svc:8080/plugin-registry/openvsx/api/redhat/vscode-yaml/1.24.0/file/yaml.vsix',
                    sha256:
                      'https://plugin-registry.openshift-devspaces.svc:8080/plugin-registry/openvsx/api/redhat/vscode-yaml/1.24.0/file/yaml.sha256',
                  },
                })
              ),
            };
          }
          if (
            url ===
            'http://plugin-registry.openshift-devspaces.svc:8080/openvsx/api/redhat/vscode-yaml/1.24.0/file/yaml.vsix'
          ) {
            return { statusCode: 200, body: yamlVsix };
          }
          if (
            url ===
            'http://plugin-registry.openshift-devspaces.svc:8080/openvsx/api/redhat/vscode-yaml/1.24.0/file/yaml.sha256'
          ) {
            return { statusCode: 200, body: Buffer.from(`${yamlSha}  yaml.vsix\n`) };
          }
          return { statusCode: 404, body: Buffer.alloc(0) };
        },
      });

      expect(summary).toEqual({
        installedVsixCount: 2,
        skippedAlreadyInstalled: 0,
        failedExtensions: [],
      });
      expect(cliCalls).toHaveLength(1);
      expect(cliCalls[0].script).toBe(baseConfig.serverScript);
      expect(cliCalls[0].args).toContain('--do-not-include-pack-dependencies');
      expect(cliCalls[0].args.filter((a) => a === '--install-extension')).toHaveLength(2);
    });

    it('rejects VSIX when SHA-256 checksum does not match', async () => {
      const yamlVsix = createMockVsixBuffer({
        publisher: 'redhat',
        name: 'vscode-yaml',
        version: '1.24.0',
      });

      const summary = await remoteInstallerMain(
        {
          ...baseConfig,
          defaultExtensions: ['redhat.vscode-yaml'],
          openVsxUrl: 'https://artifactory.corp.example.com/openvsx',
        },
        {
          log: () => {},
          serverConfigUrls: [],
          execServerCli: () => {
            throw new Error('Should not be called when SHA-256 fails');
          },
          fetchBuffer: async (url) => {
            if (url === 'https://artifactory.corp.example.com/openvsx/api/redhat/vscode-yaml') {
              return {
                statusCode: 200,
                body: Buffer.from(
                  JSON.stringify({
                    version: '1.24.0',
                    files: {
                      download: 'https://artifactory.corp.example.com/openvsx/files/yaml.vsix',
                      sha256: 'https://artifactory.corp.example.com/openvsx/files/yaml.sha256',
                    },
                  })
                ),
              };
            }
            if (url === 'https://artifactory.corp.example.com/openvsx/files/yaml.vsix') {
              return { statusCode: 200, body: yamlVsix };
            }
            if (url === 'https://artifactory.corp.example.com/openvsx/files/yaml.sha256') {
              return { statusCode: 200, body: Buffer.from('0'.repeat(64)) };
            }
            return { statusCode: 404, body: Buffer.alloc(0) };
          },
        }
      );

      expect(summary.installedVsixCount).toBe(0);
      expect(summary.failedExtensions).toEqual(['redhat.vscode-yaml']);
    });

    it('supports Artifactory Generic VSIX mirror URL templates and falls back to per-VSIX install if batch fails', async () => {
      const extAVsix = createMockVsixBuffer({ publisher: 'acme', name: 'ext-a', version: '1.0.0' });
      const extBVsix = createMockVsixBuffer({ publisher: 'acme', name: 'ext-b', version: '2.0.0' });

      const calls: string[][] = [];
      const summary = await remoteInstallerMain(
        {
          ...baseConfig,
          defaultExtensions: ['acme.ext-a@1.0.0', 'acme.ext-b@2.0.0'],
          vsixMirrorUrlTemplate:
            'https://artifactory.corp.example.com/generic/${publisher}/${name}/${publisher}.${name}-${version}.vsix',
        },
        {
          log: () => {},
          serverConfigUrls: [],
          execServerCli: (_script, args) => {
            calls.push(args);
            // Fail batch call (contains 2 --install-extension flags), succeed on individual retry for ext-a only
            const installCount = args.filter((a) => a === '--install-extension').length;
            if (installCount > 1) {
              throw new Error('Batch failed due to incompatible ext-b');
            }
            if (args[1].endsWith('ext-1.vsix')) {
              throw new Error('Incompatible engine for ext-b');
            }
          },
          fetchBuffer: async (url) => {
            if (url === 'https://artifactory.corp.example.com/generic/acme/ext-a/acme.ext-a-1.0.0.vsix') {
              return { statusCode: 200, body: extAVsix };
            }
            if (url === 'https://artifactory.corp.example.com/generic/acme/ext-b/acme.ext-b-2.0.0.vsix') {
              return { statusCode: 200, body: extBVsix };
            }
            return { statusCode: 404, body: Buffer.alloc(0) };
          },
        }
      );

      expect(calls).toHaveLength(3); // 1 batch + 2 individual retries
      expect(summary.installedVsixCount).toBe(1);
      expect(summary.failedExtensions).toEqual(['acme.ext-b@2.0.0']);
    });

    it('skips extensions that are already installed in serverDataDir/extensions', async () => {
      const installedDir = path.join(baseConfig.serverDataDir, 'extensions', 'redhat.vscode-yaml-1.24.0');
      fs.mkdirSync(installedDir, { recursive: true });
      fs.writeFileSync(
        path.join(installedDir, 'package.json'),
        JSON.stringify({ publisher: 'redhat', name: 'vscode-yaml', version: '1.24.0' })
      );

      let networkCalled = false;
      const summary = await remoteInstallerMain(
        {
          ...baseConfig,
          defaultExtensions: ['redhat.vscode-yaml'],
        },
        {
          log: () => {},
          serverConfigUrls: [],
          fetchBuffer: async () => {
            networkCalled = true;
            return { statusCode: 404, body: Buffer.alloc(0) };
          },
          execServerCli: () => {
            throw new Error('Should not invoke CLI when already installed');
          },
        }
      );

      expect(networkCalled).toBe(false);
      expect(summary).toEqual({
        installedVsixCount: 0,
        skippedAlreadyInstalled: 1,
        failedExtensions: [],
      });
    });

    it('generates a self-contained CommonJS bundle with zero unbound outer references when executed in a fresh node process', () => {
      const installedDir = path.join(baseConfig.serverDataDir, 'extensions', 'redhat.vscode-yaml-1.24.0');
      fs.mkdirSync(installedDir, { recursive: true });
      fs.writeFileSync(
        path.join(installedDir, 'package.json'),
        JSON.stringify({ publisher: 'redhat', name: 'vscode-yaml', version: '1.24.0' })
      );

      const scriptSource = buildRemoteInstallerScript({
        ...baseConfig,
        defaultExtensions: ['redhat.vscode-yaml'],
      });
      const scriptFile = path.join(tmpRoot, 'runner.cjs');
      fs.writeFileSync(scriptFile, scriptSource, 'utf8');

      const out = cp.execFileSync(process.execPath, [scriptFile, '--worker'], {
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(out).toContain('All 1 desired extension(s) are already installed.');
    });

    it('remains completely self-contained after esbuild --production minification', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const esbuild = require('esbuild');
      const minifiedOut = path.join(tmpRoot, 'ExtensionInstaller.min.cjs');
      await esbuild.build({
        entryPoints: [path.resolve(__dirname, 'ExtensionInstaller.ts')],
        bundle: true,
        outfile: minifiedOut,
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        minify: true,
        logLevel: 'silent',
      });

      // Load buildRemoteInstallerScript from the minified production bundle
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const minifiedMod = require(minifiedOut) as typeof import('./ExtensionInstaller');
      const installedDir = path.join(baseConfig.serverDataDir, 'extensions', 'redhat.vscode-yaml-1.24.0');
      fs.mkdirSync(installedDir, { recursive: true });
      fs.writeFileSync(
        path.join(installedDir, 'package.json'),
        JSON.stringify({ publisher: 'redhat', name: 'vscode-yaml', version: '1.24.0' })
      );

      const scriptSource = minifiedMod.buildRemoteInstallerScript({
        ...baseConfig,
        defaultExtensions: ['redhat.vscode-yaml'],
      });
      const scriptFile = path.join(tmpRoot, 'runner-minified.cjs');
      fs.writeFileSync(scriptFile, scriptSource, 'utf8');

      const out = cp.execFileSync(process.execPath, [scriptFile, '--worker'], {
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(out).toContain('All 1 desired extension(s) are already installed.');
    });
  });
});
