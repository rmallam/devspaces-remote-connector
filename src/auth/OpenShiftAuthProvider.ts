import * as vscode from 'vscode';
import { Logger } from '../util/Logger';
import { TokenManager, StoredToken } from './TokenManager';
import { OAuthFlow } from './OAuthFlow';
import { ClusterDiscovery, ClusterEndpoints } from './ClusterDiscovery';
import { CLUSTERS_STATE_KEY, KnownCluster, lookupKnownApiUrl, storedUrlNamesCluster, tokenStorageKeys } from '../kubernetes/knownApiUrl';
import { clusterIdFromUrl } from '../cluster/clusterId';
import { getJson } from '../util/httpClient';
import {
  CTX_AUTHENTICATED,
  STATE_CLUSTER_URL,
  STATE_CLUSTER_DISPLAY_URL,
} from '../constants';

/**
 * VS Code AuthenticationProvider for OpenShift Dev Spaces.
 *
 * Manages OAuth sessions: triggers browser-based login, stores tokens
 * in SecretStorage, and handles token refresh.
 */
export class OpenShiftAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private logger = Logger.getInstance();
  private sessionChangeEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private disposables: vscode.Disposable[] = [];
  private endpoints: ClusterEndpoints | undefined;
  private reauthInFlight: Promise<string> | undefined;

  readonly onDidChangeSessions = this.sessionChangeEmitter.event;

  constructor(
    private context: vscode.ExtensionContext,
    private tokenManager: TokenManager,
    private oauthFlow: OAuthFlow,
    private clusterDiscovery: ClusterDiscovery
  ) {
    this.disposables.push(this.sessionChangeEmitter);

    // Register background token refresh callback
    this.tokenManager.onTokenExpiring(async () => {
      await this.silentReauthenticate();
    });
  }

  /**
   * Re-run the OAuth flow. OpenShift CLI tokens have no refresh_token, so this
   * opens the browser. SSO usually completes without a full login.
   *
   * Endpoints are rediscovered from the saved API URL — they are not kept in
   * memory across VS Code restarts, which used to fail with "cannot refresh"
   * and pushed people to Clear Auth.
   */
  private async silentReauthenticate(): Promise<void> {
    const clusterUrl = this.getStoredClusterUrl();
    if (!clusterUrl) {
      throw new Error('No cluster URL stored');
    }

    const endpoints = await this.ensureEndpoints(clusterUrl, { promptForApi: false });

    this.logger.info('Silently re-authenticating...');

    const { accessToken, expiresIn } = await this.oauthFlow.execute(
      endpoints.oauthAuthorizeUrl,
      endpoints.oauthTokenUrl
    );

    const lifetimeMs = expiresIn ? expiresIn * 1000 : 24 * 60 * 60 * 1000;
    const newToken: StoredToken = {
      accessToken,
      clusterUrl,
      expiresAt: Date.now() + lifetimeMs,
      username: await this.usernameFromStored(clusterUrl),
    };

    await this.persistToken(newToken, clusterUrl);

    this.logger.info('Silent re-authentication successful');
  }

  /**
   * Get existing sessions. Returns a single session if the user is authenticated.
   */
  async getSessions(
    _scopes?: readonly string[],
    _options?: vscode.AuthenticationProviderSessionOptions
  ): Promise<vscode.AuthenticationSession[]> {
    const clusterUrl = this.getStoredClusterUrl();
    if (!clusterUrl) {
      await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, false);
      return [];
    }

    const token = await this.tokenManager.getValidToken(this.clusterTokenKeys(clusterUrl));
    if (!token) {
      await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, false);
      return [];
    }

    // Proactively check if refresh is needed (handled by background timer,
    // but also check here in case the timer hasn't fired yet)
    if (this.tokenManager.needsRefresh(token)) {
      this.logger.debug('Token needs refresh, triggering silent re-auth');
      try {
        await this.silentReauthenticate();
        const refreshed = await this.tokenManager.getValidToken(this.clusterTokenKeys(clusterUrl));
        if (refreshed) {
          return [this.tokenToSession(refreshed)];
        }
      } catch (err) {
        this.logger.warn(`Proactive refresh failed: ${err}`);
      }
    }

    await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, true);
    return [this.tokenToSession(token)];
  }

  /**
   * Create a new session by triggering the OAuth login flow.
   */
  async createSession(
    _scopes: readonly string[]
  ): Promise<vscode.AuthenticationSession> {
    this.logger.info('Starting OAuth sign-in flow...');

    // Ask user for the DevSpaces URL if not already configured
    const clusterUrl = await this.promptForClusterUrl();
    if (!clusterUrl) {
      throw new Error('Sign-in cancelled: no cluster URL provided');
    }

    // Discover against the saved API server, not the dashboard host.
    this.endpoints = await this.ensureEndpoints(clusterUrl);

    // Execute OAuth authorization code flow with PKCE (same as `oc login --web`)
    const { accessToken, expiresIn } = await this.oauthFlow.execute(
      this.endpoints.oauthAuthorizeUrl,
      this.endpoints.oauthTokenUrl
    );

    // Build token object — use server-provided expiry, fallback to 24h
    const lifetimeMs = expiresIn ? expiresIn * 1000 : 24 * 60 * 60 * 1000;
    const token: StoredToken = {
      accessToken,
      clusterUrl,
      expiresAt: Date.now() + lifetimeMs,
    };

    // Discover username from the token (query the API)
    token.username = await this.discoverUsername(token.accessToken, this.endpoints.apiUrl);
    token.clusterUrl = clusterUrl;

    await this.persistToken(token, clusterUrl);

    // Save the user's original URL for display purposes
    this.context.globalState.update(STATE_CLUSTER_DISPLAY_URL, clusterUrl);

    const session = this.tokenToSession(token);

    await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, true);

    this.sessionChangeEmitter.fire({
      added: [session],
      removed: [],
      changed: [],
    });

    this.logger.info(`Signed in as ${token.username ?? 'unknown'} to ${clusterUrl}`);
    return session;
  }

  /**
   * Remove a session (sign out).
   */
  async removeSession(_sessionId: string): Promise<void> {
    const clusterUrl = this.getStoredClusterUrl();
    if (clusterUrl) {
      const keys = this.clusterTokenKeys(clusterUrl);
      const token = await this.tokenManager.getValidToken(keys)
        ?? await this.firstStoredToken(clusterUrl);
      for (const key of keys) {
        await this.tokenManager.deleteToken(key);
      }
      if (token) {
        const session = this.tokenToSession(token);
        this.sessionChangeEmitter.fire({
          added: [],
          removed: [session],
          changed: [],
        });
      }
    }

    await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, false);
    this.logger.info('Signed out');
  }

  /**
   * Get the current access token, refreshing if needed.
   * Expired / missing tokens start Sign In — do not Clear Auth.
   */
  async getAccessToken(): Promise<string> {
    const clusterUrl = this.getStoredClusterUrl();
    if (!clusterUrl) {
      throw new Error('Not authenticated. Please sign in first.');
    }

    let token = await this.tokenManager.getValidToken(this.clusterTokenKeys(clusterUrl));

    if (token && this.tokenManager.needsRefresh(token)) {
      try {
        await this.silentReauthenticate();
        const refreshed = await this.tokenManager.getValidToken(this.clusterTokenKeys(clusterUrl));
        if (refreshed) {
          token = refreshed;
        }
      } catch (err) {
        this.logger.warn(`Token refresh in getAccessToken failed: ${err}`);
      }
    }

    if (token && this.tokenManager.isTokenValid(token)) {
      return token.accessToken;
    }

    this.logger.info('No valid OpenShift token; starting sign-in (Clear Auth is not required)');
    if (!this.reauthInFlight) {
      this.reauthInFlight = this.createSession([])
        .then((session) => session.accessToken)
        .finally(() => {
          this.reauthInFlight = undefined;
        });
    }
    return this.reauthInFlight;
  }

  /** Get the stored cluster URL. */
  getStoredClusterUrl(): string | undefined {
    return this.context.globalState.get<string>(STATE_CLUSTER_URL);
  }

  /** Get the stored cluster endpoints. */
  getEndpoints(): ClusterEndpoints | undefined {
    return this.endpoints;
  }

  /** Initialize endpoints from stored cluster URL (called on activation). */
  async initializeFromStored(): Promise<void> {
    const clusterUrl = this.getStoredClusterUrl();
    if (!clusterUrl) {
      return;
    }

    // Restore OAuth endpoints even when the token is already dead, so Sign In
    // can reuse the saved API server instead of rediscovering the dashboard.
    try {
      this.endpoints = await this.ensureEndpoints(clusterUrl, { promptForApi: false });
    } catch (err) {
      this.logger.warn(`Failed to restore cluster endpoints: ${err}`);
    }

    const token = await this.tokenManager.getValidToken(this.clusterTokenKeys(clusterUrl));
    if (!token) {
      await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, false);
      this.logger.info(`Stored token missing or expired for ${clusterUrl} — Sign In, do not Clear Auth`);
      return;
    }

    this.tokenManager.armRefresh(token);
    await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, true);
    this.logger.info(`Restored session for ${clusterUrl}`);
  }

  /**
   * API server saved at sign-in.
   * Guessing it from a shared-ingress dashboard host hangs or targets a server
   * that does not exist, and activation waits on that lookup.
   */
  private urlToDiscover(clusterUrl: string): string {
    const clusters = this.context.globalState.get<KnownCluster[]>(CLUSTERS_STATE_KEY);
    return lookupKnownApiUrl(clusters, clusterUrl) || clusterUrl;
  }

  /**
   * OAuth metadata for the OpenShift API. Never probe a shared-ingress
   * dashboard when the API URL is already stored.
   */
  private async ensureEndpoints(
    clusterUrl: string,
    opts: { promptForApi?: boolean } = {},
  ): Promise<ClusterEndpoints> {
    if (this.endpoints?.oauthAuthorizeUrl && this.endpoints.oauthTokenUrl && this.endpoints.apiUrl) {
      return this.endpoints;
    }

    const discoveryUrl = this.urlToDiscover(clusterUrl);
    try {
      this.endpoints = await this.clusterDiscovery.discover(discoveryUrl);
      this.rememberApiUrl(clusterUrl, this.endpoints.apiUrl);
      return this.endpoints;
    } catch (err) {
      if (opts.promptForApi === false) {
        throw err;
      }
      const apiUrl = await this.promptForApiUrl(err);
      this.endpoints = await this.clusterDiscovery.discover(apiUrl);
      this.rememberApiUrl(clusterUrl, this.endpoints.apiUrl);
      return this.endpoints;
    }
  }

  private async promptForApiUrl(cause: unknown): Promise<string> {
    const reason = cause instanceof Error ? cause.message : String(cause);
    this.logger.warn(`Could not discover the API server: ${reason}`);
    const input = await vscode.window.showInputBox({
      prompt: 'Paste the OpenShift API server URL (https://api.<cluster>:6443). Sign in again — do not Clear Auth. The Dev Spaces dashboard is not the API.',
      placeHolder: 'https://api.cluster.example.com:6443',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Please enter the API server URL';
        }
        const toValidate = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
        try {
          const parsed = new URL(toValidate);
          if (parsed.protocol !== 'https:') {
            return 'API URL must be https';
          }
          return undefined;
        } catch {
          return 'Please enter a valid URL';
        }
      },
    });
    if (!input) {
      throw new Error('Sign-in cancelled: no API server URL provided');
    }
    const trimmed = input.trim();
    return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  }

  private rememberApiUrl(clusterUrl: string, apiUrl: string): void {
    if (!apiUrl) {
      return;
    }
    const clusters = this.context.globalState.get<KnownCluster[]>(CLUSTERS_STATE_KEY) ?? [];
    let changed = false;
    for (const cluster of clusters) {
      if (storedUrlNamesCluster(clusterUrl, cluster) && cluster.apiUrl !== apiUrl) {
        cluster.apiUrl = apiUrl;
        changed = true;
      }
    }
    if (changed) {
      void this.context.globalState.update(CLUSTERS_STATE_KEY, clusters);
    }
  }

  private async usernameFromStored(clusterUrl: string): Promise<string | undefined> {
    const token = await this.firstStoredToken(clusterUrl);
    return token?.username;
  }

  private async firstStoredToken(clusterUrl: string): Promise<StoredToken | undefined> {
    for (const key of this.clusterTokenKeys(clusterUrl)) {
      const stored = await this.tokenManager.getToken(key);
      if (stored) {
        return stored;
      }
    }
    return undefined;
  }

  private storeClusterUrl(url: string): void {
    this.context.globalState.update(STATE_CLUSTER_URL, url);
  }

  /**
   * Keys the OpenShift token may be stored under after a shared-ingress
   * dashboard rewrite. Connect looks up STATE_CLUSTER_URL, which becomes
   * cheURL; the token itself was saved under the API server.
   */
  private clusterTokenKeys(clusterUrl: string): string[] {
    return tokenStorageKeys(
      clusterUrl,
      this.context.globalState.get<KnownCluster[]>(CLUSTERS_STATE_KEY),
      [
        this.endpoints?.apiUrl,
        this.endpoints?.devSpacesUrl,
        this.endpoints?.appsDomain,
        clusterIdFromUrl(this.endpoints?.apiUrl || clusterUrl),
      ].filter((value): value is string => Boolean(value)),
    );
  }

  private async persistToken(token: StoredToken, clusterUrl: string): Promise<void> {
    for (const key of this.clusterTokenKeys(clusterUrl)) {
      await this.tokenManager.storeToken(key, { ...token, clusterUrl: key });
    }
    this.storeClusterUrl(clusterUrl);
  }

  private async promptForClusterUrl(): Promise<string | undefined> {
    // Read from globalState (set by ClusterManager)
    const storedUrl = this.context.globalState.get<string>(STATE_CLUSTER_URL);
    if (storedUrl) {
      return storedUrl;
    }

    // No cluster configured — ask the user
    const inputUrl = await vscode.window.showInputBox({
      prompt: 'Enter any URL from your Dev Spaces cluster',
      placeHolder: 'https://devspaces.apps.your-cluster.example.com',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Please enter a URL';
        }
        // Add https:// for validation if missing
        const toValidate = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
        try {
          new URL(toValidate);
          return undefined;
        } catch {
          return 'Please enter a valid URL';
        }
      },
    });

    if (!inputUrl) {
      return undefined;
    }

    // Save to globalState for future use
    this.context.globalState.update(STATE_CLUSTER_URL, inputUrl.trim());
    this.logger.info(`Cluster URL saved: ${inputUrl.trim()}`);

    return inputUrl.trim();
  }

  /**
   * Discover the authenticated user's username from the OpenShift API.
   */
  private async discoverUsername(
    accessToken: string,
    apiUrl: string
  ): Promise<string | undefined> {
    try {
      const user = await getJson<{ metadata?: { name?: string } }>(
        `${apiUrl}/apis/user.openshift.io/v1/users/~`,
        { Authorization: `Bearer ${accessToken}` }
      );
      return user.metadata?.name;
    } catch {
      return undefined;
    }
  }

  private tokenToSession(token: StoredToken): vscode.AuthenticationSession {
    return {
      id: `devspaces-${token.clusterUrl}`,
      accessToken: token.accessToken,
      account: {
        id: token.username ?? 'unknown',
        label: token.username ?? 'OpenShift User',
      },
      scopes: [],
    };
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
