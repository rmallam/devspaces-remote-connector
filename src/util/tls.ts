import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as os from 'os';
import * as tls from 'tls';
import { CA_BUNDLE } from '../generated/ca-bundle';
import { Logger } from './Logger';

/** Cached extra CA certificates (PEM format) */
let extraCAs: string | undefined;

/** Extension-scoped TLS certificate verification toggle (avoids process-wide NODE_TLS_REJECT_UNAUTHORIZED). */
let certificateValidationEnabled = true;

export function setCertificateValidationEnabled(enabled: boolean): void {
  certificateValidationEnabled = enabled;
}

export function isCertificateValidationEnabled(): boolean {
  return certificateValidationEnabled;
}

/**
 * Load CA certificates for TLS trust.
 *
 * Strategy:
 * 1. If a CA bundle is bundled with the extension, use it exclusively (skip system CAs)
 * 2. Otherwise, fall back to exporting CAs from the OS keychain/store
 *
 * Call once during extension activation, before any HTTPS calls.
 */
export function loadSystemCAs(): void {
  const logger = Logger.getInstance();

  // If a CA bundle is bundled in the extension, use it and skip system CAs entirely.
  // This avoids issues with expired certs in system stores (e.g. Windows).
  if (CA_BUNDLE && CA_BUNDLE.trim().length > 0) {
    extraCAs = CA_BUNDLE.trim();
    const certCount = (extraCAs.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    logger.debug(`[TLS] Using bundled CA bundle (${certCount} certs). Skipping system CA loading.`);
    return;
  }

  logger.debug('[TLS] No bundled CA bundle found, falling back to system CAs.');

  if (process.env.NODE_EXTRA_CA_CERTS) {
    try {
      extraCAs = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf-8');
      logger.debug(`[TLS] Loaded CAs from NODE_EXTRA_CA_CERTS: ${process.env.NODE_EXTRA_CA_CERTS}`);
    } catch { /* ignore */ }
    return;
  }

  try {
    let certs: string | undefined;

    if (process.platform === 'darwin') {
      const keychains = [
        '/System/Library/Keychains/SystemRootCertificates.keychain',
        '/Library/Keychains/System.keychain',
      ];
      const loginKeychain = path.join(os.homedir(), 'Library/Keychains/login.keychain-db');
      if (fs.existsSync(loginKeychain)) {
        keychains.push(loginKeychain);
      }
      certs = execFileSync('security', [
        'find-certificate', '-a', '-p',
        ...keychains,
      ], { encoding: 'utf-8', timeout: 15_000 });
      logger.debug('[TLS] Exported system CAs from macOS keychains.');

    } else if (process.platform === 'win32') {
      certs = execFileSync('powershell', [
        '-NoProfile', '-Command',
        `@('Root','CA') | ForEach-Object {
          Get-ChildItem -Path "Cert:\\LocalMachine\\$_" | ForEach-Object {
            "-----BEGIN CERTIFICATE-----"
            [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')
            "-----END CERTIFICATE-----"
          }
        }`,
      ], { encoding: 'utf-8', timeout: 15_000 });
      logger.debug('[TLS] Exported system CAs from Windows certificate store.');

    } else {
      const linuxPaths = [
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/pki/tls/certs/ca-bundle.crt',
        '/etc/ssl/ca-bundle.pem',
        '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
      ];
      for (const p of linuxPaths) {
        if (fs.existsSync(p)) {
          process.env.NODE_EXTRA_CA_CERTS = p;
          extraCAs = fs.readFileSync(p, 'utf-8');
          logger.debug(`[TLS] Using Linux CA bundle: ${p}`);
          return;
        }
      }
      logger.debug('[TLS] No Linux CA bundle found at standard paths.');
    }

    if (certs && certs.length > 100) {
      extraCAs = certs;
      const caFile = path.join(os.tmpdir(), `devspaces-cas-${crypto.randomBytes(8).toString('hex')}.pem`);
      fs.writeFileSync(caFile, certs, { mode: 0o600 });
      process.env.NODE_EXTRA_CA_CERTS = caFile;
      const certCount = (certs.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
      logger.debug(`[TLS] Wrote ${certCount} system CAs to ${caFile}`);
    }
  } catch (err) {
    logger.debug(`[TLS] System CA export failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Get an HTTPS agent that trusts both Node's built-in roots AND the
 * extra CAs we loaded (bundled CAs, or system CAs as fallback).
 *
 * Use this for all HTTPS requests in the extension to ensure enterprise
 * CAs are trusted regardless of whether NODE_EXTRA_CA_CERTS took effect.
 */
export function getHttpsAgent(): https.Agent {
  const ca = buildCAList();
  const logger = Logger.getInstance();
  logger.debug(`[TLS] HTTPS agent created with ${ca.length} total CA certs (${tls.rootCertificates.length} Node built-in + ${ca.length - tls.rootCertificates.length} extra), rejectUnauthorized=${certificateValidationEnabled}.`);
  return new https.Agent({ ca, rejectUnauthorized: certificateValidationEnabled });
}

/**
 * Build the full CA list: Node's built-in roots + our extra CAs.
 */
function buildCAList(): (string | Buffer)[] {
  const cas: (string | Buffer)[] = [...tls.rootCertificates];

  if (extraCAs) {
    const certs = extraCAs.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (certs) {
      cas.push(...certs);
    }
  }

  return cas;
}
