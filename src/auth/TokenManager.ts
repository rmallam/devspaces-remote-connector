import * as vscode from 'vscode';
import { Logger } from '../util/Logger';
import { TOKEN_REFRESH_BUFFER } from '../constants';

export interface StoredToken {
  accessToken: string;
  expiresAt?: number; // epoch ms
  clusterUrl: string;
  username?: string;
}

const TOKEN_KEY_PREFIX = 'devspaces.token.';

/** Default token lifetime if the server doesn't tell us (1 hour). */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/**
 * Manages OAuth token storage, retrieval, and refresh.
 *
 * Tokens are stored in globalState (local SQLite DB) instead of
 * SecretStorage (OS keychain) to avoid the "OS keyring couldn't be
 * identified" error on macOS which causes tokens to not persist
 * across restarts. This is acceptable because:
 * - OAuth tokens are short-lived (24h expiry)
 * - Tokens are refreshed automatically via SSO
 * - globalState is local to the machine and not synced
 */
export class TokenManager {
  private logger = Logger.getInstance();
  private refreshTimers = new Map<string, NodeJS.Timeout>();
  private onTokenExpiringCallback: ((clusterUrl: string) => Promise<void>) | undefined;

  constructor(private globalState: vscode.Memento) {}

  onTokenExpiring(callback: (clusterUrl: string) => Promise<void>): void {
    this.onTokenExpiringCallback = callback;
  }

  /** Resume the expiry timer after VS Code restart. */
  armRefresh(token: StoredToken): void {
    this.scheduleRefresh(token);
  }

  async storeToken(clusterUrl: string, token: StoredToken): Promise<void> {
    if (!token.expiresAt) {
      token.expiresAt = Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
    }

    const key = this.keyFor(clusterUrl);
    await this.globalState.update(key, JSON.stringify(token));

    const expiresIn = Math.round((token.expiresAt - Date.now()) / 1000);
    this.logger.info(`Token stored for ${clusterUrl} (expires in ${expiresIn}s)`);

    this.scheduleRefresh(token);
  }

  async getValidToken(keys: string[]): Promise<StoredToken | undefined> {
    const primaryKey = keys.find((k) => Boolean(k?.trim()))?.trim();
    for (const key of keys) {
      if (!key) {
        continue;
      }
      const stored = await this.getToken(key);
      if (stored && this.isTokenValid(stored)) {
        if (primaryKey && key !== primaryKey) {
          const primaryStored = await this.getToken(primaryKey);
          if (!primaryStored || !this.isTokenValid(primaryStored)) {
            await this.storeToken(primaryKey, { ...stored, clusterUrl: primaryKey });
          }
        }
        return stored;
      }
    }
    return undefined;
  }

  /**
   * Consolidate a cluster's token under its canonical key and remove redundant alias keys.
   */
  async consolidateTokenKeys(canonicalKey: string, aliasKeys: string[]): Promise<void> {
    const target = canonicalKey.trim();
    if (!target) {
      return;
    }
    const valid = await this.getValidToken([target, ...aliasKeys]);
    if (!valid) {
      return;
    }
    await this.storeToken(target, { ...valid, clusterUrl: target });
    for (const alias of aliasKeys) {
      const trimmed = alias.trim();
      if (trimmed && trimmed !== target) {
        await this.deleteToken(trimmed);
      }
    }
  }

  /**
   * Copy a valid token onto another lookup key (the CheCluster dashboard host).
   */
  async copyToken(fromKeys: string[], toKey: string): Promise<void> {
    const target = toKey.trim();
    if (!target) {
      return;
    }
    const existing = await this.getToken(target);
    if (existing && this.isTokenValid(existing)) {
      return;
    }
    const token = await this.getValidToken(fromKeys);
    if (!token) {
      return;
    }
    await this.storeToken(target, { ...token, clusterUrl: target });
  }

  async getToken(clusterUrl: string): Promise<StoredToken | undefined> {
    const key = this.keyFor(clusterUrl);
    const raw = this.globalState.get<string>(key);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as StoredToken;
    } catch {
      this.logger.warn(`Corrupt token data for ${clusterUrl}, clearing`);
      await this.deleteToken(clusterUrl);
      return undefined;
    }
  }

  async deleteToken(clusterUrl: string): Promise<void> {
    const key = this.keyFor(clusterUrl);
    await this.globalState.update(key, undefined);
    this.logger.debug(`Token deleted for ${clusterUrl}`);
    this.cancelRefreshTimer(clusterUrl);
  }

  isTokenValid(token: StoredToken): boolean {
    if (!token.expiresAt) {
      return true;
    }
    return Date.now() < token.expiresAt;
  }

  needsRefresh(token: StoredToken): boolean {
    if (!token.expiresAt) {
      return false;
    }
    return Date.now() >= token.expiresAt - TOKEN_REFRESH_BUFFER;
  }

  private keyFor(clusterUrl: string): string {
    return `${TOKEN_KEY_PREFIX}${clusterUrl}`;
  }

  private scheduleRefresh(token: StoredToken): void {
    const timerKey = token.clusterUrl;
    this.cancelRefreshTimer(timerKey);

    if (!token.expiresAt) {
      return;
    }

    const refreshIn = token.expiresAt - TOKEN_REFRESH_BUFFER - Date.now();

    if (refreshIn <= 0) {
      this.logger.warn(`Token for ${timerKey} is already within refresh window, triggering refresh now`);
      void this.triggerRefresh(timerKey);
      return;
    }

    const refreshInSec = Math.round(refreshIn / 1000);
    const expiresInSec = Math.round((token.expiresAt - Date.now()) / 1000);
    this.logger.info(
      `Token expires in ${expiresInSec}s, scheduling refresh in ${refreshInSec}s`
    );

    const timer = setTimeout(() => {
      this.refreshTimers.delete(timerKey);
      void this.triggerRefresh(timerKey);
    }, refreshIn);
    this.refreshTimers.set(timerKey, timer);
  }

  private async triggerRefresh(clusterUrl: string): Promise<void> {
    this.logger.info(`Background token refresh triggered for ${clusterUrl}`);

    if (!this.onTokenExpiringCallback) {
      this.logger.warn('No refresh callback registered — token will expire');
      return;
    }

    try {
      await this.onTokenExpiringCallback(clusterUrl);
      this.logger.info(`Background token refresh completed for ${clusterUrl}`);
    } catch (err) {
      this.logger.error(`Background token refresh failed for ${clusterUrl}: ${err}`);
      const action = await vscode.window.showWarningMessage(
        'Dev Spaces session is about to expire. Sign in again to continue.',
        'Sign In'
      );
      if (action === 'Sign In') {
        vscode.commands.executeCommand('devspaces.signIn');
      }
    }
  }

  private cancelRefreshTimer(clusterUrl?: string): void {
    if (clusterUrl !== undefined) {
      const timer = this.refreshTimers.get(clusterUrl);
      if (timer) {
        clearTimeout(timer);
        this.refreshTimers.delete(clusterUrl);
      }
      return;
    }
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
  }

  dispose(): void {
    this.cancelRefreshTimer();
  }
}
