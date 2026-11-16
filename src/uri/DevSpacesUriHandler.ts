import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { Logger } from '../util/Logger';
import { ClusterManager, ClusterEntry } from '../cluster/ClusterManager';
import { OpenShiftAuthProvider } from '../auth/OpenShiftAuthProvider';
import { ClusterDiscovery } from '../auth/ClusterDiscovery';
import { KubeClientFactory } from '../kubernetes/KubeClientFactory';
import { NamespaceApi } from '../kubernetes/NamespaceApi';
import { DevWorkspaceResource } from '../kubernetes/DevWorkspaceTypes';
import { WorkspaceModel } from '../workspace/WorkspaceModel';
import { copyKiroAuthToPod, discoverProjectFolder } from '../commands/workspaceHelpers';
import { ActiveConnectionInfo } from '../commands/remoteCommands';
import { storedUrlNamesCluster } from '../kubernetes/knownApiUrl';
import { getJson } from '../util/httpClient';
import {
  DEVSPACES_AUTHORITY,
  DW_API_GROUP,
  DW_API_VERSION,
  DW_PLURAL,
  PROJECTS_ROOT,
  STATE_ACTIVE_CONNECTION,
  STATE_CLUSTER_DISPLAY_URL,
  STATE_CLUSTER_URL,
  STATE_CONNECTIONS_MAP,
  WorkspacePhase,
} from '../constants';

const SAFE_K8S_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const SAFE_PROJECT_PATH_RE = /^\/projects(?:\/[a-zA-Z0-9._-]+)*$/;

export interface ParsedHandoffRequest {
  workspaceName: string;
  dashboardUrl?: string;
  apiUrl?: string;
  namespace?: string;
  devworkspaceId?: string;
  projectPath?: string;
}

export interface UriHandlerDeps {
  context: vscode.ExtensionContext;
  clusterManager: ClusterManager;
  authProvider: Pick<OpenShiftAuthProvider, 'getAccessToken' | 'getEndpoints'>;
  clusterDiscovery: ClusterDiscovery;
  kubeClientFactory: KubeClientFactory;
  onClusterRegistered?: () => Promise<void>;
}

/**
 * Parse and strictly validate an incoming `vscode://<ext>/open?...` handoff URI.
 *
 * Works across all OpenShift topologies (self-managed OCP, ARO, OSD, ROSA,
 * and custom shared-ingress domains) without relying on hostname regexes.
 */
export function parseHandoffUri(uri: vscode.Uri): ParsedHandoffRequest | undefined {
  const cleanPath = (uri.path || '').replace(/\/+$/, '');
  if (cleanPath && cleanPath !== '/open' && cleanPath !== '/connect') {
    return undefined;
  }

  const params = new URLSearchParams(uri.query || '');
  const rawWorkspace = (params.get('workspace') ?? params.get('ws') ?? '').trim();
  if (!rawWorkspace || !SAFE_K8S_NAME_RE.test(rawWorkspace)) {
    return undefined;
  }

  const dashboardUrl = sanitizeHttpsOrigin(params.get('dashboardUrl') ?? params.get('clusterUrl') ?? '');
  const apiUrl = sanitizeHttpsOrigin(params.get('apiUrl') ?? '');
  if (!dashboardUrl && !apiUrl) {
    return undefined;
  }

  const rawNamespace = (params.get('namespace') ?? params.get('ns') ?? '').trim();
  const namespace = rawNamespace && SAFE_K8S_NAME_RE.test(rawNamespace) ? rawNamespace : undefined;

  const rawDwId = (params.get('devworkspaceId') ?? params.get('id') ?? '').trim();
  const devworkspaceId = rawDwId && SAFE_K8S_NAME_RE.test(rawDwId) ? rawDwId : undefined;

  const rawProject = (params.get('project') ?? params.get('folder') ?? '').trim();
  const projectPath = rawProject && SAFE_PROJECT_PATH_RE.test(rawProject) && !rawProject.includes('..')
    ? rawProject
    : undefined;

  return {
    workspaceName: rawWorkspace,
    dashboardUrl,
    apiUrl,
    namespace,
    devworkspaceId,
    projectPath,
  };
}

function sanitizeHttpsOrigin(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      return undefined;
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
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * Handles `vscode://redhat.devspaces-remote-connector/open?...` and
 * `kiro://redhat.devspaces-remote-connector/open?...` browser handoff links.
 */
export class DevSpacesUriHandler implements vscode.UriHandler {
  private logger = Logger.getInstance();

  constructor(private deps: UriHandlerDeps) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    this.logger.info(`Handling incoming URI: ${uri.toString()}`);
    const req = parseHandoffUri(uri);
    if (!req) {
      vscode.window.showErrorMessage(
        'Invalid Dev Spaces link. Expected workspace name and HTTPS cluster URL.'
      );
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting to Dev Spaces workspace "${req.workspaceName}"`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Resolving cluster...' });
          const cluster = await this.ensureClusterRegistered(req);

          await this.deps.context.globalState.update(STATE_CLUSTER_URL, cluster.devSpacesUrl);
          await this.deps.context.globalState.update(STATE_CLUSTER_DISPLAY_URL, cluster.devSpacesUrl);

          progress.report({ message: 'Authenticating with OpenShift...' });
          const token = await this.deps.authProvider.getAccessToken();

          const apiUrl = await this.resolveApiUrl(cluster, req);
          if (apiUrl && apiUrl !== cluster.apiUrl) {
            await this.deps.clusterManager.updateCluster(cluster.id, {
              apiUrl,
              devSpacesUrl: req.dashboardUrl || cluster.devSpacesUrl,
              appsDomain: cluster.appsDomain,
            });
            cluster.apiUrl = apiUrl;
          }

          if (this.deps.onClusterRegistered) {
            void this.deps.onClusterRegistered().catch(() => undefined);
          }

          const kubeConfig = this.deps.kubeClientFactory.createConfig(apiUrl, token);
          const namespace = req.namespace || await this.resolveUserNamespace(kubeConfig, cluster, token, req.workspaceName);

          progress.report({ message: 'Checking workspace status...' });
          const { devworkspaceId, gitRepoUrl } = await this.ensureWorkspaceRunning(
            kubeConfig,
            namespace,
            req.workspaceName,
            req.devworkspaceId
          );

          const wsModel: WorkspaceModel = {
            name: req.workspaceName,
            namespace,
            devworkspaceId,
            clusterId: cluster.id,
            displayName: req.workspaceName,
            phase: WorkspacePhase.Running,
            started: true,
            gitRepoUrl,
          };

          // Sync Kiro credentials if applicable (best effort)
          try {
            const isKiro = vscode.env.appName?.toLowerCase().includes('kiro');
            const copyCredentials = vscode.workspace.getConfiguration('devspaces').get<boolean>('kiroCopyCredentials', true);
            if (isKiro && copyCredentials) {
              await copyKiroAuthToPod(kubeConfig, wsModel);
            }
          } catch {
            // Best-effort
          }

          progress.report({ message: 'Discovering project folder...' });
          let projectFolder = req.projectPath && req.projectPath !== PROJECTS_ROOT
            ? req.projectPath
            : PROJECTS_ROOT;
          if (projectFolder === PROJECTS_ROOT) {
            try {
              projectFolder = await discoverProjectFolder(kubeConfig, wsModel);
            } catch {
              projectFolder = PROJECTS_ROOT;
            }
          }

          const hostAlias = `${req.workspaceName}@${cluster.id}`;
          const connInfo: ActiveConnectionInfo = {
            workspaceName: req.workspaceName,
            namespace,
            devworkspaceId,
            hostAlias,
            clusterUrl: cluster.devSpacesUrl,
            projectFolder,
          };
          await this.deps.context.globalState.update(STATE_ACTIVE_CONNECTION, connInfo);
          const connectionsMap = this.deps.context.globalState.get<Record<string, ActiveConnectionInfo>>(STATE_CONNECTIONS_MAP, {});
          connectionsMap[hostAlias] = connInfo;
          await this.deps.context.globalState.update(STATE_CONNECTIONS_MAP, connectionsMap);

          const openBehavior = vscode.workspace.getConfiguration('devspaces').get<string>('openBehavior', 'newWindow');
          const forceNewWindow = process.env.DEVSPACES_DEBUG ? false : openBehavior !== 'currentWindow';

          const remoteUri = vscode.Uri.parse(`vscode-remote://${DEVSPACES_AUTHORITY}+${hostAlias}${projectFolder}`);
          this.logger.info(`URI handoff opening remote workspace: ${remoteUri.toString()} (newWindow: ${forceNewWindow})`);
          await vscode.commands.executeCommand('vscode.openFolder', remoteUri, { forceNewWindow });
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`URI handoff failed: ${msg}`);
      if (!msg.toLowerCase().includes('cancelled')) {
        vscode.window.showErrorMessage(`Failed to open Dev Spaces workspace: ${msg}`);
      }
    }
  }

  private async ensureClusterRegistered(req: ParsedHandoffRequest): Promise<ClusterEntry> {
    const candidates = [req.dashboardUrl, req.apiUrl].filter((v): v is string => Boolean(v));
    const existing = this.deps.clusterManager.getClusters().find((c) =>
      candidates.some((url) => storedUrlNamesCluster(url, c))
    );
    if (existing) {
      const updatedApi = req.apiUrl || existing.apiUrl;
      const updatedDash = req.dashboardUrl || existing.devSpacesUrl;
      if (updatedApi !== existing.apiUrl || updatedDash !== existing.devSpacesUrl) {
        await this.deps.clusterManager.updateCluster(existing.id, {
          apiUrl: updatedApi,
          devSpacesUrl: updatedDash,
          appsDomain: existing.appsDomain,
        });
        return this.deps.clusterManager.getClusters().find((c) => c.id === existing.id) ?? existing;
      }
      return existing;
    }

    const primaryUrl = req.dashboardUrl ?? req.apiUrl!;
    const appsDomain = this.deps.clusterDiscovery.extractAppsDomain(req.apiUrl ?? primaryUrl) ?? '';
    return this.deps.clusterManager.addCluster(
      primaryUrl,
      req.apiUrl && req.dashboardUrl
        ? { apiUrl: req.apiUrl, devSpacesUrl: req.dashboardUrl, appsDomain }
        : undefined
    );
  }

  private async resolveApiUrl(cluster: ClusterEntry, req: ParsedHandoffRequest): Promise<string> {
    if (req.apiUrl) {
      return req.apiUrl;
    }
    if (cluster.apiUrl) {
      return cluster.apiUrl;
    }
    const providerEndpoints = this.deps.authProvider.getEndpoints();
    if (providerEndpoints?.apiUrl) {
      return providerEndpoints.apiUrl;
    }
    const discovered = await this.deps.clusterDiscovery.discover(req.dashboardUrl ?? cluster.devSpacesUrl);
    return discovered.apiUrl;
  }

  private async resolveUserNamespace(
    kubeConfig: k8s.KubeConfig,
    cluster: ClusterEntry,
    token: string,
    workspaceName: string
  ): Promise<string> {
    if (cluster.namespace) {
      return cluster.namespace;
    }
    const server = kubeConfig.getCurrentCluster()?.server ?? cluster.apiUrl;
    const userRes = await getJson<{ metadata?: { name?: string } }>(
      `${server}/apis/user.openshift.io/v1/users/~`,
      { Authorization: `Bearer ${token}` }
    );
    const username = userRes.metadata?.name;
    if (!username) {
      throw new Error('Could not determine authenticated OpenShift username');
    }

    const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    const customApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
    const nsApi = new NamespaceApi(coreApi, customApi, cluster.devSpacesUrl, token);
    const ns = await nsApi.findUserNamespace(username, workspaceName);
    if (!ns) {
      throw new Error(`Could not locate namespace for workspace "${workspaceName}"`);
    }
    await this.deps.clusterManager.updateClusterNamespace(cluster.id, ns, username);
    return ns;
  }

  private async ensureWorkspaceRunning(
    kubeConfig: k8s.KubeConfig,
    namespace: string,
    workspaceName: string,
    hintedDwId?: string
  ): Promise<{ devworkspaceId: string; gitRepoUrl?: string }> {
    const customApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
    let dw = await customApi.getNamespacedCustomObject({
      group: DW_API_GROUP,
      version: DW_API_VERSION,
      namespace,
      plural: DW_PLURAL,
      name: workspaceName,
    }) as DevWorkspaceResource;

    const phase = dw?.status?.phase;
    if (phase === 'Stopped' || phase === 'Failed') {
      await customApi.patchNamespacedCustomObject({
        group: DW_API_GROUP,
        version: DW_API_VERSION,
        namespace,
        plural: DW_PLURAL,
        name: workspaceName,
        body: [{ op: 'replace', path: '/spec/started', value: true }],
      });
    }

    if (phase !== 'Running') {
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        dw = await customApi.getNamespacedCustomObject({
          group: DW_API_GROUP,
          version: DW_API_VERSION,
          namespace,
          plural: DW_PLURAL,
          name: workspaceName,
        }) as DevWorkspaceResource;
        if (dw?.status?.phase === 'Running') {
          break;
        }
        if (dw?.status?.phase === 'Failed') {
          throw new Error(`Workspace "${workspaceName}" entered Failed phase`);
        }
      }
    }

    const devworkspaceId = dw?.status?.devworkspaceId || hintedDwId || '';
    const gitRepoUrl = dw?.spec?.template?.projects?.[0]?.git?.remotes?.origin;
    return { devworkspaceId, gitRepoUrl };
  }
}
