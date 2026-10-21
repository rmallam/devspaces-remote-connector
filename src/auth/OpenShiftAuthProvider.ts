import * as vscode from 'vscode';
import { Logger } from '../util/Logger';
import { TokenManager, StoredToken } from './TokenManager';
import { OAuthFlow } from './OAuthFlow';
import { ClusterDiscovery, ClusterEndpoints } from './ClusterDiscovery';
import { CLUSTERS_STATE_KEY, KnownCluster, lookupKnownApiUrl } from '../kubernetes/knownApiUrl';
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
   * Silently re-authenticate by re-running the OAuth flow.
   * Since the user is already SSO'd, the browser round-trip is near-instant.
   */
  private async silentReauthenticate(): Promise<void> {
    if (!this.endpoints) {
      throw new Error('No cluster endpoints — cannot refresh');
    }

    this.logger.info('Silently re-authenticating...');

    const { accessToken, expiresIn } = await this.oauthFlow.execute(
      this.endpoints.oauthAuthorizeUrl,
      this.endpoints.oauthTokenUrl
    );

    const clusterUrl = this.getStoredClusterUrl();
    if (!clusterUrl) {
      throw new Error('No cluster URL stored');
    }

    const oldToken = await this.tokenManager.getToken(clusterUrl);
    const lifetimeMs = expiresIn ? expiresIn * 1000 : 24 * 60 * 60 * 1000;

    const newToken: StoredToken = {
      accessToken,
      clusterUrl,
      expiresAt: Date.now() + lifetimeMs,
      username: oldToken?.username,
    };

    await this.tokenManager.storeToken(clusterUrl, newToken);
    this.storeClusterUrl(clusterUrl);

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

    const token = await this.tokenManager.getToken(clusterUrl);
    if (!token || !this.tokenManager.isTokenValid(token)) {
      await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, false);
      return [];
    }

    // Proactively check if refresh is needed (handled by background timer,
    // but also check here in case the timer hasn't fired yet)
    if (this.tokenManager.needsRefresh(token)) {
      this.logger.debug('Token needs refresh, triggering silent re-auth');
      try {
        await this.silentReauthenticate();
        const refreshed = await this.tokenManager.getToken(clusterUrl);
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

    // Discover cluster endpoints. A later reconnect stores the shared-ingress
    // dashboard in place of the API URL the user typed; keep using that API.
    this.endpoints = await this.clusterDiscovery.discover(this.urlToDiscover(clusterUrl));

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

    // Store token and cluster URL
    await this.tokenManager.storeToken(clusterUrl, token);
    // Also store under the cluster ID (appsDomain) so initCluster can find it
    if (this.endpoints.appsDomain) {
      await this.tokenManager.storeToken(this.endpoints.appsDomain, token);
      // Also store under the cluster short prefix (e.g. devspc-1d)
      const parts = this.endpoints.appsDomain.replace(/^apps\./, '').split('.');
      if (parts.length >= 3) {
        await this.tokenManager.storeToken(parts[0], token);
      }
    }
    this.storeClusterUrl(clusterUrl);

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
      const token = await this.tokenManager.getToken(clusterUrl);
      if (token) {
        await this.tokenManager.deleteToken(clusterUrl);
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
   * Throws if not authenticated.
   */
  async getAccessToken(): Promise<string> {
    const clusterUrl = this.getStoredClusterUrl();
    if (!clusterUrl) {
      throw new Error('Not authenticated. Please sign in first.');
    }

    let token = await this.tokenManager.getToken(clusterUrl);
    if (!token) {
      throw new Error('No stored token. Please sign in again.');
    }

    // Refresh if needed
    if (this.tokenManager.needsRefresh(token)) {
      try {
        await this.silentReauthenticate();
        const refreshed = await this.tokenManager.getToken(clusterUrl);
        if (refreshed) {
          token = refreshed;
        }
      } catch (err) {
        this.logger.warn(`Token refresh in getAccessToken failed: ${err}`);
      }
    }

    if (!this.tokenManager.isTokenValid(token)) {
      throw new Error('Token expired. Please sign in again.');
    }

    return token.accessToken;
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

    const token = await this.tokenManager.getToken(clusterUrl);
    if (!token) {
      return;
    }

    try {
      this.endpoints = await this.clusterDiscovery.discover(this.urlToDiscover(clusterUrl));
      await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, true);
      this.logger.info(`Restored session for ${clusterUrl}`);
    } catch (err) {
      this.logger.warn(`Failed to restore session: ${err}`);
    }
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

  private storeClusterUrl(url: string): void {
    this.context.globalState.update(STATE_CLUSTER_URL, url);
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
