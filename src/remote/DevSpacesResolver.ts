import * as vscode from 'vscode';
import * as net from 'net';
import * as crypto from 'crypto';
import * as k8s from '@kubernetes/client-node';
import { Logger } from '../util/Logger';
import { getServerConfig } from './ServerConfig';
import { installServerViaExec } from './ServerSetup';
import { WorkspaceStatusMonitor } from './WorkspaceStatusMonitor';
import { DEVSPACES_AUTHORITY, DW_API_GROUP, DW_API_VERSION, DW_PLURAL, STATE_CONNECTIONS_MAP, STATE_ACTIVE_CONNECTION, PROJECTS_ROOT } from '../constants';
import { parseHostAlias } from '../util/workspaceNameExtractor';
import { NamespaceApi } from '../kubernetes/NamespaceApi';
import { getJson } from '../util/httpClient';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceConnectionInfo {
  workspaceName: string;
  namespace: string;
  devworkspaceId: string;
  hostAlias: string;
  clusterUrl: string;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * RemoteAuthorityResolver for DevSpaces workspaces.
 *
 * Resolves a remote authority to a TCP host:port by:
 * 1. Looking up connection info for the workspace
 * 2. Authenticating and discovering the pod
 * 3. Installing the REH server on the pod
 * 4. Port-forwarding to the server
 *
 * Delegates pod health monitoring to WorkspaceStatusMonitor.
 */
export class DevSpacesResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {
  private logger = Logger.getInstance();
  private labelFormatter: vscode.Disposable | undefined;
  private kubeConfig: k8s.KubeConfig | undefined;
  private activeConnectionInfo: WorkspaceConnectionInfo | undefined;
  private portForwardServer: net.Server | undefined;
  private statusMonitor: WorkspaceStatusMonitor | undefined;
  private stableConnectionToken: string | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private getConnectionInfo: (hostAlias: string) => Promise<WorkspaceConnectionInfo | undefined>,
    private getKubeConfig: (clusterUrl: string, extraKeys?: string[]) => Promise<k8s.KubeConfig | undefined>,
    private findWorkspacePod: (kubeConfig: k8s.KubeConfig, namespace: string, devworkspaceId: string) => Promise<{ podName: string; containerName: string }>,
    private checkAndStartWorkspace: (clusterUrl: string, namespace: string, workspaceName: string, extraKeys?: string[]) => Promise<'running' | 'started' | 'failed' | 'auth_failed' | 'not_found'>
  ) {}

  // ─── Public API ──────────────────────────────────────────────────────────

  tunnelFactory = (
    tunnelOptions: vscode.TunnelOptions,
    _tunnelCreationOptions: vscode.TunnelCreationOptions
  ): Thenable<vscode.Tunnel> | undefined => {
    if (!this.kubeConfig || !this.activeConnectionInfo) { return undefined; }
    const connInfo = this.activeConnectionInfo;
    const remotePort = tunnelOptions.remoteAddress.port;
    const localPort = tunnelOptions.localAddressPort || 0;

    return this.findWorkspacePod(this.kubeConfig, connInfo.namespace, connInfo.devworkspaceId)
      .then(({ podName }) => this.createAppTunnel(connInfo.namespace, podName, remotePort, localPort));
  };

  async resolve(
    authority: string,
    resolverContext: vscode.RemoteAuthorityResolverContext
  ): Promise<vscode.ResolverResult> {
    const [prefix, hostAlias] = authority.split('+');
    if (prefix !== DEVSPACES_AUTHORITY) {
      throw new Error(`Unexpected authority prefix: ${prefix}`);
    }

    this.logger.info(`Resolving '${authority}' (attempt #${resolverContext.resolveAttempt})`);

    return vscode.window.withProgress(
      { title: 'Connecting to DevSpaces workspace', location: vscode.ProgressLocation.Notification, cancellable: false },
      async () => {
        try {
          return await this.doResolve(hostAlias);
        } catch (e: unknown) {
          return await this.handleResolveError(e);
        }
      }
    );
  }

  dispose(): void {
    this.statusMonitor?.dispose();
    this.statusMonitor = undefined;
    this.portForwardServer?.close();
    this.portForwardServer = undefined;
    this.labelFormatter?.dispose();
    this.labelFormatter = undefined;
  }

  // ─── Core Resolve Flow ───────────────────────────────────────────────────

  private async doResolve(hostAlias: string): Promise<vscode.ResolverResult> {
    const connInfo = await this.resolveConnectionInfo(hostAlias);
    await this.resolveKubeConfig(connInfo);

    // Extract cluster ID for token lookup fallback
    const extraKeys: string[] = [];
    const atIdx = connInfo.hostAlias.indexOf('@');
    if (atIdx !== -1) {
      extraKeys.push(connInfo.hostAlias.slice(atIdx + 1));
    }

    // Discover namespace if missing (e.g. opening from recent after auth was cleared)
    if (!connInfo.namespace) {
      await this.discoverNamespace(connInfo);
    }

    // Discover devworkspaceId if missing
    if (!connInfo.devworkspaceId && connInfo.namespace && connInfo.workspaceName) {
      await this.discoverDevworkspaceId(connInfo);
    }

    // Ensure workspace is running (handles cold start after IDE reopen)
    const wsStatus = await this.checkAndStartWorkspace(connInfo.clusterUrl, connInfo.namespace, connInfo.workspaceName, extraKeys);
    if (wsStatus === 'not_found') {
      await this.showWorkspaceDeletedDialog(connInfo);
      throw vscode.RemoteAuthorityResolverError.NotAvailable(
        `Workspace "${connInfo.workspaceName}" no longer exists. It may have been deleted.`
      );
    } else if (wsStatus === 'auth_failed') {
      this.logger.info('Token expired, triggering browser sign-in...');
      await vscode.authentication.getSession('openshift-devspaces', [], { forceNewSession: true });
      await this.resolveKubeConfig(connInfo);
      const retryStatus = await this.checkAndStartWorkspace(connInfo.clusterUrl, connInfo.namespace, connInfo.workspaceName, extraKeys);
      if (retryStatus === 'failed' || retryStatus === 'auth_failed') {
        throw new Error(`Workspace ${connInfo.workspaceName} failed to start.`);
      }
    } else if (wsStatus === 'failed') {
      throw new Error(`Workspace ${connInfo.workspaceName} failed to start.`);
    }

    const { podName, containerName } = await this.discoverPod(connInfo);
    await this.persistConnectionState(connInfo);
    const { listeningOn, connectionToken } = await this.installREH(connInfo, podName, containerName);
    const localPort = await this.establishPortForward(connInfo.namespace, podName, listeningOn);
    this.registerLabelFormatter(hostAlias);
    this.startStatusMonitor(connInfo, podName);

    return new vscode.ResolvedAuthority('127.0.0.1', localPort, connectionToken);
  }

  // ─── Resolve Steps ───────────────────────────────────────────────────────

  private async resolveConnectionInfo(hostAlias: string): Promise<WorkspaceConnectionInfo> {
    const connInfo = await this.getConnectionInfo(hostAlias);
    if (!connInfo) {
      throw new Error(`No connection info for ${hostAlias}. Use "Dev Spaces: Connect to Workspace" first.`);
    }
    this.activeConnectionInfo = connInfo;
    return connInfo;
  }

  private async resolveKubeConfig(connInfo: WorkspaceConnectionInfo): Promise<void> {
    // Extract cluster ID from hostAlias (format: workspaceName@clusterId) to use as extra token lookup key.
    // This handles the case where devSpacesUrl was updated to a CNAME (e.g. devspaces.example.com)
    // but the token was stored under the original cluster ID or apps domain.
    const extraKeys: string[] = [];
    const atIdx = connInfo.hostAlias.indexOf('@');
    if (atIdx !== -1) {
      extraKeys.push(connInfo.hostAlias.slice(atIdx + 1));
    }

    let kc = await this.getKubeConfig(connInfo.clusterUrl, extraKeys);
    if (!kc) {
      this.logger.info('No valid token, triggering sign-in...');
      try {
        await vscode.authentication.getSession('openshift-devspaces', [], { createIfNone: true });
        kc = await this.getKubeConfig(connInfo.clusterUrl, extraKeys);
      } catch (err) {
        this.logger.error(`Auto sign-in failed: ${err}`);
      }
    }
    if (!kc) {
      throw new Error('Not authenticated. Please sign in via the Dev Spaces sidebar.');
    }
    this.kubeConfig = kc;
  }

  private async discoverNamespace(connInfo: WorkspaceConnectionInfo): Promise<void> {
    this.logger.info('Namespace missing, discovering...');
    const kc = this.kubeConfig!;
    const server = kc.getCurrentCluster()?.server ?? '';
    const user = kc.getCurrentUser();
    const token = user?.token ?? '';

    // Get username from OpenShift API
    try {
      const userInfo = await getJson<{ metadata?: { name?: string } }>(
        `${server}/apis/user.openshift.io/v1/users/~`,
        { Authorization: `Bearer ${token}` }
      );
      const username = userInfo.metadata?.name;
      if (!username) { throw new Error('Could not determine username'); }

      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
      const namespaceApi = new NamespaceApi(coreApi, customApi, connInfo.clusterUrl, token);
      const ns = await namespaceApi.findUserNamespace(username, connInfo.workspaceName);
      if (ns) {
        connInfo.namespace = ns;
        this.logger.info(`Namespace discovered: ${ns}`);
      } else {
        throw new Error(`No namespace found for user ${username}`);
      }
    } catch (err) {
      throw new Error(`Failed to discover namespace: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async persistConnectionState(connInfo: WorkspaceConnectionInfo): Promise<void> {
    try {
      await this.context.globalState.update(STATE_ACTIVE_CONNECTION, connInfo);
      const connectionsMap = this.context.globalState.get<Record<string, WorkspaceConnectionInfo>>(STATE_CONNECTIONS_MAP, {}) ?? {};
      connectionsMap[connInfo.hostAlias] = connInfo;
      await this.context.globalState.update(STATE_CONNECTIONS_MAP, connectionsMap);
    } catch (err) {
      this.logger.debug(`Could not persist active connection state: ${err}`);
    }
  }

  private async discoverDevworkspaceId(connInfo: WorkspaceConnectionInfo): Promise<void> {
    this.logger.debug(`Discovering devworkspaceId for ${connInfo.workspaceName} in ${connInfo.namespace}`);
    try {
      const customApi = this.kubeConfig!.makeApiClient(k8s.CustomObjectsApi);
      const dw = await customApi.getNamespacedCustomObject({
        group: DW_API_GROUP,
        version: DW_API_VERSION,
        namespace: connInfo.namespace,
        plural: DW_PLURAL,
        name: connInfo.workspaceName,
      }) as any;
      const id = dw?.status?.devworkspaceId ?? dw?.metadata?.uid ?? '';
      if (id) {
        connInfo.devworkspaceId = id;
        this.logger.debug(`DevWorkspace ID discovered: ${id}`);
      }
    } catch (err) {
      this.logger.debug(`Could not discover devworkspaceId: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async discoverPod(connInfo: WorkspaceConnectionInfo): Promise<{ podName: string; containerName: string }> {
    this.logger.info(`Finding pod for ${connInfo.workspaceName}`);
    const timeout = 120_000;
    const deadline = Date.now() + timeout;

    while (true) {
      try {
        return await this.findWorkspacePod(this.kubeConfig!, connInfo.namespace, connInfo.devworkspaceId);
      } catch {
        if (Date.now() >= deadline) {
          throw new Error(`Workspace pod not found after ${timeout / 1000}s.`);
        }
        this.logger.info(`Pod not ready, waiting... (${Math.round((deadline - Date.now()) / 1000)}s remaining)`);
        await this.sleep(3000);
      }
    }
  }

  private async installREH(
    connInfo: WorkspaceConnectionInfo,
    podName: string,
    containerName: string
  ): Promise<{ listeningOn: number; connectionToken: string }> {
    this.logger.info(`Installing REH on ${podName}/${containerName}`);
    const serverConfig = await getServerConfig();
    const connectionToken = crypto.randomUUID();
    this.stableConnectionToken = connectionToken;
    const result = await installServerViaExec(
      this.kubeConfig!, connInfo.namespace, podName, containerName, serverConfig, connectionToken
    );
    this.logger.info(`REH listening on port ${result.listeningOn}`);
    return { listeningOn: result.listeningOn, connectionToken };
  }

  private async establishPortForward(namespace: string, podName: string, remotePort: number): Promise<number> {
    this.portForwardServer?.close();
    this.portForwardServer = undefined;

    const forward = new k8s.PortForward(this.kubeConfig!);
    const server = net.createServer((socket) => {
      void forward.portForward(namespace, podName, [remotePort], socket, null, socket);
    });

    const localPort = await new Promise<number>((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

    this.portForwardServer = server;
    this.logger.info(`Port-forward: localhost:${localPort} → ${podName}:${remotePort}`);
    return localPort;
  }

  private registerLabelFormatter(hostAlias: string): void {
    this.labelFormatter?.dispose();
    const parsed = parseHostAlias(hostAlias);
    let suffix: string;
    if (parsed) {
      const clusters = this.context.globalState.get<any[]>('devspaces.clusters', []);
      suffix = clusters.length > 1 ? `${parsed.workspaceName}@${parsed.clusterId}` : parsed.workspaceName;
    } else {
      suffix = hostAlias;
    }
    this.labelFormatter = vscode.workspace.registerResourceLabelFormatter({
      scheme: 'vscode-remote',
      authority: `${DEVSPACES_AUTHORITY}+${hostAlias}`,
      formatting: {
        label: '${path}',
        separator: '/',
        tildify: true,
        workspaceSuffix: suffix,
      },
    });
    vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true);
  }

  // ─── Status Monitor ──────────────────────────────────────────────────────

  private startStatusMonitor(connInfo: WorkspaceConnectionInfo, podName: string): void {
    this.statusMonitor?.dispose();
    this.statusMonitor = new WorkspaceStatusMonitor(
      {
        getKubeConfig: this.getKubeConfig,
        findWorkspacePod: this.findWorkspacePod,
        checkAndStartWorkspace: this.checkAndStartWorkspace,
      },
      this.kubeConfig!,
      podName,
      this.stableConnectionToken
    );
    this.statusMonitor.start(connInfo);
  }

  // ─── Error Handling ──────────────────────────────────────────────────────

  private async handleResolveError(e: unknown): Promise<never> {
    this.logger.error(`Resolve error: ${e}`);
    this.statusMonitor?.stop();

    if (e instanceof vscode.RemoteAuthorityResolverError) { throw e; }

    const connInfo = this.activeConnectionInfo;
    if (!connInfo) {
      throw vscode.RemoteAuthorityResolverError.NotAvailable(
        e instanceof Error ? e.message : String(e)
      );
    }

    // Create a temporary monitor to query phase
    const monitor = new WorkspaceStatusMonitor(
      { getKubeConfig: this.getKubeConfig, findWorkspacePod: this.findWorkspacePod, checkAndStartWorkspace: this.checkAndStartWorkspace },
      this.kubeConfig ?? new k8s.KubeConfig(),
      '',
      undefined
    );

    const phase = await monitor.queryWorkspacePhase(connInfo);
    this.logger.info(`Phase: ${phase}`);

    switch (phase) {
      case 'Running':
        this.logger.info('Workspace is Running, waiting for pod to be ready...');
        await monitor.waitForPodReady(connInfo, 120_000);
        return this.retryTemporarily('Reconnecting to workspace...');
      case 'Starting': {
        this.logger.info('Workspace Starting, waiting for Running...');
        const reached = await monitor.waitForPhase(connInfo, 'Running', 300_000);
        if (reached) {
          await monitor.waitForPodReady(connInfo, 120_000);
          return this.retryTemporarily('Reconnecting to workspace...');
        }
        return this.handleStoppedPhase(e);
      }
      case 'Stopping':
        return this.retryTemporarily('Workspace is stopping...');
      case 'NotFound':
        await this.showWorkspaceDeletedDialog(connInfo);
        throw vscode.RemoteAuthorityResolverError.NotAvailable(
          `Workspace "${connInfo.workspaceName}" no longer exists. It may have been deleted.`
        );
      default:
        return this.handleStoppedPhase(e);
    }
  }

  private handleStoppedPhase(originalError: unknown): never {
    throw vscode.RemoteAuthorityResolverError.NotAvailable(
      originalError instanceof Error ? originalError.message : String(originalError)
    );
  }

  private async showWorkspaceDeletedDialog(connInfo: WorkspaceConnectionInfo): Promise<void> {
    this.logger.show();

    // Remove stale connection info from globalState
    const connectionsMap = this.context.globalState.get<Record<string, any>>(STATE_CONNECTIONS_MAP, {});
    if (connectionsMap[connInfo.hostAlias]) {
      delete connectionsMap[connInfo.hostAlias];
      await this.context.globalState.update(STATE_CONNECTIONS_MAP, connectionsMap);
    }
    // Clear active connection if it matches
    const active = this.context.globalState.get<any>(STATE_ACTIVE_CONNECTION);
    if (active?.hostAlias === connInfo.hostAlias) {
      await this.context.globalState.update(STATE_ACTIVE_CONNECTION, undefined);
    }

    await vscode.window.showErrorMessage(
      `Workspace "${connInfo.workspaceName}" no longer exists. It may have been deleted from the cluster.`,
      { modal: true },
      'Close Remote',
    );

    // Remove from VS Code's recently opened list
    try {
      const remoteUri = vscode.Uri.parse(
        `vscode-remote://${DEVSPACES_AUTHORITY}+${connInfo.hostAlias}${PROJECTS_ROOT}`
      );
      await vscode.commands.executeCommand('vscode.removeFromRecentlyOpened', remoteUri.toString());
      this.logger.info(`Removed ${remoteUri.toString()} from recently opened`);
    } catch (err) {
      this.logger.debug(`Could not remove from recently opened: ${err}`);
    }

    // Always close — there's nothing to connect to
    await vscode.commands.executeCommand('workbench.action.remote.close');
  }

  private retryTemporarily(message: string): never {
    throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(message);
  }

  // ─── App Port Tunneling ──────────────────────────────────────────────────

  private async createAppTunnel(
    namespace: string,
    podName: string,
    remotePort: number,
    localPort: number
  ): Promise<vscode.Tunnel> {
    const forward = new k8s.PortForward(this.kubeConfig!);
    const onDidDisposeEmitter = new vscode.EventEmitter<void>();

    const server = net.createServer((socket) => {
      void forward.portForward(namespace, podName, [remotePort], socket, null, socket);
    });

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(localPort, '127.0.0.1', () => resolve());
    });

    const actualPort = (server.address() as net.AddressInfo).port;
    this.logger.info(`App tunnel: localhost:${actualPort} → ${podName}:${remotePort}`);

    return {
      remoteAddress: { host: '127.0.0.1', port: remotePort },
      localAddress: { host: '127.0.0.1', port: actualPort },
      onDidDispose: onDidDisposeEmitter.event,
      dispose: () => { server.close(); onDidDisposeEmitter.fire(); onDidDisposeEmitter.dispose(); },
    };
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
