import * as vscode from 'vscode';
import { Logger } from './util/Logger';
import { extractWorkspaceName, parseHostAlias } from './util/workspaceNameExtractor';
import { OpenShiftAuthProvider } from './auth/OpenShiftAuthProvider';
import { TokenManager } from './auth/TokenManager';

/** Git commit SHA injected at build time by webpack DefinePlugin */
declare const BUILD_COMMIT: string;
import { OAuthFlow } from './auth/OAuthFlow';
import { ClusterDiscovery } from './auth/ClusterDiscovery';
import { KubeClientFactory } from './kubernetes/KubeClientFactory';
import { WorkspaceTreeProvider } from './ui/WorkspaceTreeProvider';
import { WorkspaceTreeItem } from './ui/WorkspaceTreeItem';
import { StatusBarManager } from './ui/StatusBarManager';
import { ClusterManager } from './cluster/ClusterManager';
import { ClusterSessionManager } from './cluster/ClusterSessionManager';
import { DevSpacesResolver } from './remote/DevSpacesResolver';
import { createGetKubeConfig, createFindPodAndContainer, createCheckAndStartWorkspace } from './remote/resolverCallbacks';
import { registerRemoteCommands, ActiveConnectionInfo, track } from './commands/remoteCommands';
import { registerWorkspaceCommands } from './commands/workspaceCommands';
import { registerAuthCommands } from './commands/authCommands';
import { registerClusterCommands } from './commands/clusterCommands';
import { loadSystemCAs, setCertificateValidationEnabled } from './util/tls';
import {
  AUTH_PROVIDER_ID,
  AUTH_PROVIDER_LABEL,
  CTX_CONNECTED,
  STATE_ACTIVE_CONNECTION,
  DEVSPACES_AUTHORITY,
} from './constants';

let logger: Logger;
let oldConfig: vscode.WorkspaceConfiguration;
let cleanupFn: (() => Promise<void>) | undefined;
let cleanupIntervalsFn: (() => void) | undefined;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  logger = Logger.getInstance();
  logger.info('Dev Spaces Connector activating...');

  // Log extension version and build info for diagnostics
  const ext = vscode.extensions.getExtension('redhat.devspaces-remote-connector');
  const version = ext?.packageJSON?.version ?? 'unknown';
  logger.info(`[Version] ${version} (${BUILD_COMMIT})`);

  // Log IDE detection at startup
  const { detectIDE } = await import('./util/IDEDetector');
  const ide = detectIDE();
  logger.info(`[IDE Detection] isVSCode=${ide.isVSCode}, isOSS=${ide.isOSS}, isVSCodium=${ide.isVSCodium}, isUnknownFork=${ide.isUnknownFork}, isKiro=${ide.isKiro}`);
  logger.info(`[IDE Detection] App Name: ${vscode.env.appName}, URI Scheme: ${vscode.env.uriScheme}`);

  setCertificateValidationEnabled(
    vscode.workspace.getConfiguration('devspaces').get('certificateValidation.enabled', true)
  );

  loadSystemCAs();

  // --- Set IDE detection context ---
  const isKiroIDE = vscode.env.appName?.toLowerCase().includes('kiro') ?? false;
  vscode.commands.executeCommand('setContext', 'devspaces.isKiroIDE', isKiroIDE);

  // --- Register the Remote Authority Resolver ---
  registerResolver(context);

  // --- Detect if we're in a remote session ---
  const effectiveRemote = vscode.env.remoteName ?? '';
  if (effectiveRemote.startsWith(DEVSPACES_AUTHORITY)) {
    await setupRemoteSession(context, effectiveRemote);
    return;
  }

  // --- Local session: full UI and commands ---
  await setupLocalSession(context);

  logger.info('Dev Spaces Connector activated');
}

export async function deactivate(): Promise<void> {
  if (cleanupIntervalsFn) { cleanupIntervalsFn(); cleanupIntervalsFn = undefined; }
  if (cleanupFn) {
    try { await cleanupFn(); } catch { /* best-effort */ }
    cleanupFn = undefined;
  }
  logger?.info('Dev Spaces Connector deactivated');
}

// =========================================================================
// Remote Authority Resolver
// =========================================================================

function registerResolver(context: vscode.ExtensionContext): void {
  try {
    const resolverTokenManager = new TokenManager(context.globalState);
    const resolverKubeFactory = new KubeClientFactory();
    const resolverClusterDiscovery = new ClusterDiscovery();

    const resolverClusterManager = new ClusterManager(context.globalState);

    const resolver = new DevSpacesResolver(
      context,
      async (hostAlias: string) => {
        // Try connections map first (supports multiple recent workspaces)
        const connectionsMap = context.globalState.get<Record<string, any>>('devspaces.connectionsMap', {});
        if (connectionsMap[hostAlias]) { return connectionsMap[hostAlias]; }
        // Fallback: parse clusterId from hostAlias and construct minimal connection info
        const parsed = parseHostAlias(hostAlias);
        if (parsed) {
          const clusters = resolverClusterManager.getClusters();
          const cluster = clusters.find((c) => c.id === parsed.clusterId)
            ?? clusters.find((c) => {
              // Match by apps domain prefix (e.g. devspc-1d from apps.devspc-1d.ctyz...)
              if (!c.appsDomain) { return false; }
              const prefix = c.appsDomain.replace(/^apps\./, '').split('.')[0];
              return prefix === parsed.clusterId;
            });
          if (cluster) {
            return {
              workspaceName: parsed.workspaceName,
              namespace: cluster.namespace ?? '',
              devworkspaceId: '',
              hostAlias,
              clusterUrl: cluster.devSpacesUrl,
            };
          }
        }
        return undefined;
      },
      createGetKubeConfig(context.globalState, resolverTokenManager, resolverKubeFactory, resolverClusterDiscovery),
      createFindPodAndContainer(),
      createCheckAndStartWorkspace(context.globalState, resolverTokenManager, resolverKubeFactory, resolverClusterDiscovery)
    );

    context.subscriptions.push(
      vscode.workspace.registerRemoteAuthorityResolver(DEVSPACES_AUTHORITY, resolver)
    );
    context.subscriptions.push(resolver);
    logger.info('Remote authority resolver registered (K8s exec transport)');
  } catch (err) {
    logger.info(`Resolver API not available, will delegate to Remote-SSH: ${err instanceof Error ? err.message : err}`);
  }
}

// =========================================================================
// Remote Session Setup
// =========================================================================

async function setupRemoteSession(context: vscode.ExtensionContext, effectiveRemote: string): Promise<void> {
  logger.info(`Running in remote session: ${effectiveRemote}`);
  vscode.commands.executeCommand('setContext', CTX_CONNECTED, true);
  vscode.commands.executeCommand('setContext', 'devspaces.isRemoteSession', true);

  // Register auth provider so re-auth works in remote window
  const tokenManager = new TokenManager(context.globalState);
  const oauthFlow = new OAuthFlow();
  const clusterDiscovery = new ClusterDiscovery();
  const authProvider = new OpenShiftAuthProvider(context, tokenManager, oauthFlow, clusterDiscovery);
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      AUTH_PROVIDER_ID, AUTH_PROVIDER_LABEL, authProvider,
      { supportsMultipleAccounts: false }
    )
  );

  const remoteAuthority = process.env.VSCODE_REMOTE_AUTHORITY ?? '';
  const workspaceName = extractWorkspaceName(remoteAuthority);

  const statusBar = new StatusBarManager();
  statusBar.setConnected(workspaceName);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.disconnect', async () => {
      await vscode.commands.executeCommand('workbench.action.remote.close');
    })
  );

  const activeConn = context.globalState.get<ActiveConnectionInfo>(STATE_ACTIVE_CONNECTION);
  if (activeConn) {
    logger.info(`Remote session: found connection info for ${activeConn.workspaceName}`);
    registerRemoteCommands(context, activeConn);
  } else {
    logger.warn('Remote session: no active connection info found — remote commands unavailable');
  }

  // --- Idling Support ---
  const eventsToTrack = [
    vscode.workspace.onDidChangeTextDocument,
    vscode.window.onDidChangeActiveTextEditor,
    vscode.window.onDidChangeTextEditorSelection,
    vscode.window.onDidChangeTextEditorViewColumn,
    vscode.window.onDidChangeWindowState,
    vscode.window.onDidChangeTerminalState,
    vscode.window.onDidChangeActiveTerminal,
  ];
  await track(eventsToTrack, logger, context, authProvider);
}

// =========================================================================
// Local Session Setup
// =========================================================================

async function setupLocalSession(context: vscode.ExtensionContext): Promise<void> {
  // --- Core services ---
  const tokenManager = new TokenManager(context.globalState);
  const oauthFlow = new OAuthFlow();
  const clusterDiscovery = new ClusterDiscovery();
  const kubeClientFactory = new KubeClientFactory();

  // --- Auth provider ---
  const authProvider = new OpenShiftAuthProvider(context, tokenManager, oauthFlow, clusterDiscovery);
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      AUTH_PROVIDER_ID, AUTH_PROVIDER_LABEL, authProvider,
      { supportsMultipleAccounts: false }
    )
  );

  // --- UI ---
  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // --- Tree provider ---
  let treeProvider: WorkspaceTreeProvider | undefined;
  let treeViewCreated = false;

  function ensureTreeProvider(): WorkspaceTreeProvider {
    if (!treeProvider) {
      treeProvider = new WorkspaceTreeProvider();
      context.subscriptions.push(treeProvider);
    }
    if (!treeViewCreated && !vscode.env.remoteName) {
      const treeView = vscode.window.createTreeView('devspacesWorkspaces', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
      });
      context.subscriptions.push(treeView);
      treeViewCreated = true;
    }
    return treeProvider;
  }

  // --- Cluster manager ---
  const clusterManager = new ClusterManager(context.globalState);
  await clusterManager.ensureDefaults();

  // --- Cluster session manager ---
  const sessionManager = new ClusterSessionManager(
    context, tokenManager, clusterDiscovery, kubeClientFactory,
    clusterManager, authProvider, ensureTreeProvider
  );

  cleanupIntervalsFn = () => sessionManager.disposeIntervals();

  // --- Register commands ---
  registerAuthCommands({
    context,
    authProvider,
    tokenManager,
    clusterManager,
    statusBar,
    treeProvider: () => treeProvider,
    clusterWorkspaceManagers: sessionManager.getManagers(),
    refreshIntervals: sessionManager.getRefreshIntervals(),
    loadAllClusters: () => sessionManager.loadAllClusters(),
  });

  registerClusterCommands({
    context,
    clusterManager,
    tokenManager,
    authProvider,
    treeProvider: () => treeProvider,
    clusterWorkspaceManagers: sessionManager.getManagers(),
    refreshIntervals: sessionManager.getRefreshIntervals(),
    initCluster: (id, url) => sessionManager.initCluster(id, url),
    cleanupConnection,
  });

  registerWorkspaceCommands({
    context,
    getManagerForCommand: async (item?: WorkspaceTreeItem) => {
      if (item?.workspace) {
        const wm = sessionManager.getManagerForWorkspace(item.workspace);
        if (wm) { return wm; }
      }
      return sessionManager.ensureWorkspaceManager();
    },
    ensureWorkspaceManager: () => sessionManager.ensureWorkspaceManager(),
    clusterWorkspaceManagers: sessionManager.getManagers(),
    loadAllClusters: () => sessionManager.loadAllClusters(),
    clusterManager,
    authProvider,
    kubeClientFactory,
  });

  // --- Disconnect command ---
  async function cleanupConnection(silent = false): Promise<void> {
    const activeConn = context.globalState.get<ActiveConnectionInfo>(STATE_ACTIVE_CONNECTION);
    if (activeConn) {
      await context.globalState.update(STATE_ACTIVE_CONNECTION, undefined);
    }
    statusBar.setDisconnected();
    await vscode.commands.executeCommand('setContext', CTX_CONNECTED, false);
    if (!silent) {
      vscode.window.showInformationMessage('Disconnected from Dev Spaces');
    }
  }

  oldConfig = vscode.workspace.getConfiguration('devspaces');
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(params => {
    if (!params.affectsConfiguration('devspaces')) {
      return;
    }
    const newConfig = vscode.workspace.getConfiguration('devspaces');

    if (hasConfigKeyChanged('certificateValidation.enabled', oldConfig, newConfig)) {
      setCertificateValidationEnabled(newConfig.get('certificateValidation.enabled', true));
    }

    oldConfig = newConfig;
  }));

  function hasConfigKeyChanged(key: string, oldConfig: vscode.WorkspaceConfiguration, newConfig: vscode.WorkspaceConfiguration) {
    const oldValue = oldConfig.get(key);
    const newValue = newConfig.get(key);
    return Array.isArray(oldValue) && Array.isArray(newValue)
      ? JSON.stringify(oldValue) !== JSON.stringify(newValue)
      : oldValue !== newValue;
  }

  cleanupFn = () => cleanupConnection(true);

  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.disconnect', async () => {
      await cleanupConnection();
    })
  );

  // --- Restore session on activation ---
  try {
    await authProvider.initializeFromStored();
    const sessions = await authProvider.getSessions();
    const hasClusters = clusterManager.getClusters().length > 0;
    if (sessions.length > 0 || hasClusters) {
      if (hasClusters) {
        await vscode.commands.executeCommand('setContext', 'devspaces.isAuthenticated', true);
      }
      await sessionManager.loadAllClusters();
      const activeConn = context.globalState.get<ActiveConnectionInfo>(STATE_ACTIVE_CONNECTION);
      if (activeConn) {
        logger.info(`Active connection found for ${activeConn.workspaceName}`);
      }
    }
  } catch (err) {
    logger.debug(`Session restore skipped: ${err}`);
  }

  // --- Hide Remote Explorer ---
  const hideRemoteExplorer = vscode.workspace
    .getConfiguration('devspaces')
    .get<boolean>('hideRemoteExplorer', true);

  if (hideRemoteExplorer) {
    await vscode.commands.executeCommand('setContext', 'devspaces.hideRemoteExplorer', true);
    logger.debug('To hide the Remote Explorer sidebar: right-click its icon in the activity bar → Hide');
  }
}
