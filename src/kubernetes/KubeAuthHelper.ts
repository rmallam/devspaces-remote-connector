import * as k8s from '@kubernetes/client-node';
import { Logger } from '../util/Logger';
import { TokenManager } from '../auth/TokenManager';
import { ClusterDiscovery } from '../auth/ClusterDiscovery';
import { KubeClientFactory } from './KubeClientFactory';
import { SIDECAR_PREFIXES, DW_API_GROUP, DW_API_VERSION, DW_PLURAL, LABEL_DEVWORKSPACE_ID } from '../constants';
import { DevWorkspaceResource } from './DevWorkspaceTypes';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PodInfo {
  podName: string;
  containerName: string;
}

// ─── KubeAuthHelper ──────────────────────────────────────────────────────────

/**
 * Shared helper for the "get token → discover endpoints → create KubeConfig" flow.
 *
 * This pattern is used by the resolver callbacks, remote commands, and
 * cluster session manager. Centralizing it here eliminates duplication
 * and ensures consistent token lookup across all code paths.
 */
export class KubeAuthHelper {
  private logger = Logger.getInstance();

  constructor(
    private tokenManager: TokenManager,
    private clusterDiscovery: ClusterDiscovery,
    private kubeClientFactory: KubeClientFactory
  ) {}

  /**
   * Resolve a valid access token for a cluster URL.
   *
   * Tries multiple key variants since tokens may be stored under
   * the cluster URL, the apps domain, or a cluster ID.
   */
  async resolveToken(clusterUrl: string, extraKeys: string[] = []): Promise<string | undefined> {
    const keysToTry = [clusterUrl, ...extraKeys];
    const appsDomain = this.clusterDiscovery.extractAppsDomain(clusterUrl);
    if (appsDomain) {
      keysToTry.push(appsDomain);
      // Also try the cluster short prefix (e.g. devspc-1d from apps.devspc-1d.ctyz.p1...)
      const parts = appsDomain.replace(/^apps\./, '').split('.');
      if (parts.length >= 3) {
        keysToTry.push(parts[0]);
      }
    }

    for (const key of keysToTry) {
      const storedToken = await this.tokenManager.getToken(key);
      if (storedToken && this.tokenManager.isTokenValid(storedToken)) {
        this.logger.debug(`Token resolved (key=${key})`);
        return storedToken.accessToken;
      }
    }

    this.logger.debug(`No valid token found for ${clusterUrl}`);
    return undefined;
  }

  /**
   * Build an authenticated KubeConfig for a cluster URL.
   *
   * Returns undefined if no valid token is available.
   */
  async getKubeConfig(clusterUrl: string, extraKeys: string[] = [], knownApiUrl?: string): Promise<k8s.KubeConfig | undefined> {
    try {
      const tokenKeys = knownApiUrl ? [...extraKeys, knownApiUrl] : extraKeys;
      const accessToken = await this.resolveToken(clusterUrl, tokenKeys);
      if (!accessToken) { return undefined; }

      // A shared-ingress dashboard host is not a safe place to guess the API.
      const apiUrl = knownApiUrl || (await this.clusterDiscovery.discover(clusterUrl)).apiUrl;
      return this.kubeClientFactory.createConfig(apiUrl, accessToken);
    } catch (err) {
      this.logger.error(`getKubeConfig failed for ${clusterUrl}: ${err}`);
      return undefined;
    }
  }

  /**
   * Build an authenticated KubeConfig, throwing if not authenticated.
   */
  async requireKubeConfig(clusterUrl: string, extraKeys: string[] = [], knownApiUrl?: string): Promise<k8s.KubeConfig> {
    const kc = await this.getKubeConfig(clusterUrl, extraKeys, knownApiUrl);
    if (!kc) {
      throw new Error('Not authenticated — please sign in again.');
    }
    return kc;
  }
}

// ─── Pod Discovery ───────────────────────────────────────────────────────────

/**
 * Find the workspace pod and its main container for a given DevWorkspace ID.
 *
 * The main container is determined by:
 * 1. Reading the DevWorkspace CR to find the component with mountSources=true
 * 2. Matching that component name to a pod container
 * 3. Falling back to the first non-sidecar container
 */
export async function findWorkspacePodAndContainer(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  devworkspaceId: string
): Promise<PodInfo> {
  const logger = Logger.getInstance();
  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);

  const podList = await coreApi.listNamespacedPod({
    namespace,
    labelSelector: `${LABEL_DEVWORKSPACE_ID}=${devworkspaceId}`,
  });

  const pods = podList.items;
  if (pods.length === 0) {
    throw new Error(`No running pod found for workspace ${devworkspaceId}`);
  }

  const pod = pods[0];
  const containers = pod.spec?.containers ?? [];

  // Try to determine main container from DevWorkspace CR
  let mainContainerName: string | undefined;
  const workspaceName = pod.metadata?.labels?.['controller.devfile.io/devworkspace_name'] ?? '';

  if (workspaceName) {
    try {
      const customApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
      const dw = await customApi.getNamespacedCustomObject({
        group: DW_API_GROUP,
        version: DW_API_VERSION,
        namespace,
        plural: DW_PLURAL,
        name: workspaceName,
      }) as DevWorkspaceResource;

      const components = dw?.spec?.template?.components ?? [];
      for (const comp of components) {
        if (comp.container && comp.container.mountSources !== false) {
          mainContainerName = comp.name;
          break;
        }
      }
      logger.debug(`DevWorkspace ${workspaceName}: main container = ${mainContainerName}`);
    } catch (err) {
      logger.debug(`Could not read DevWorkspace CR: ${err}`);
    }
  }

  // Match component name to pod container
  let mainContainer: k8s.V1Container | undefined;
  if (mainContainerName) {
    mainContainer = containers.find((c) => c.name === mainContainerName);
  }

  // Fallback: first container that isn't a known sidecar
  if (!mainContainer) {
    mainContainer = containers.find(
      (c: k8s.V1Container) => !SIDECAR_PREFIXES.some((prefix) => c.name.startsWith(prefix))
    ) ?? containers[0];
  }

  return {
    podName: pod.metadata?.name ?? '',
    containerName: mainContainer?.name ?? 'tools',
  };
}

// ─── DevWorkspace Phase Utilities ────────────────────────────────────────────

/**
 * Poll a DevWorkspace until it reaches a target phase or times out.
 *
 * @returns true if the target phase was reached, false on timeout or failure
 */
export async function waitForWorkspacePhase(
  customApi: k8s.CustomObjectsApi,
  namespace: string,
  workspaceName: string,
  targetPhase: string,
  timeoutMs: number,
  failPhases: string[] = ['Failed']
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const check = await customApi.getNamespacedCustomObject({
      group: DW_API_GROUP,
      version: DW_API_VERSION,
      namespace,
      plural: DW_PLURAL,
      name: workspaceName,
    }) as DevWorkspaceResource;
    const phase = check?.status?.phase;
    if (phase === targetPhase) { return true; }
    if (phase && failPhases.includes(phase)) { return false; }
  }
  return false;
}

/**
 * Get the current phase of a DevWorkspace.
 */
export async function getDevWorkspacePhase(
  customApi: k8s.CustomObjectsApi,
  namespace: string,
  workspaceName: string
): Promise<string> {
  const dw = await customApi.getNamespacedCustomObject({
    group: DW_API_GROUP,
    version: DW_API_VERSION,
    namespace,
    plural: DW_PLURAL,
    name: workspaceName,
  }) as DevWorkspaceResource;
  return dw?.status?.phase ?? 'Unknown';
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
