import * as k8s from '@kubernetes/client-node';
import { Logger } from '../util/Logger';
import { TokenManager } from '../auth/TokenManager';
import { ClusterDiscovery } from '../auth/ClusterDiscovery';
import { KubeClientFactory } from '../kubernetes/KubeClientFactory';
import {
  KubeAuthHelper,
  findWorkspacePodAndContainer,
  waitForWorkspacePhase,
} from '../kubernetes/KubeAuthHelper';
import { DW_API_GROUP, DW_API_VERSION, DW_PLURAL } from '../constants';
import { CLUSTERS_STATE_KEY, KnownCluster, lookupKnownApiUrl } from '../kubernetes/knownApiUrl';
import { DevWorkspaceResource } from '../kubernetes/DevWorkspaceTypes';

const logger = Logger.getInstance();

/**
 * Creates the getKubeConfig callback for the DevSpacesResolver.
 */
export function createGetKubeConfig(
  globalState: { get<T>(key: string): T | undefined },
  tokenManager: TokenManager,
  kubeFactory: KubeClientFactory,
  clusterDiscovery: ClusterDiscovery
) {
  const helper = new KubeAuthHelper(tokenManager, clusterDiscovery, kubeFactory);

  return async (clusterUrl: string, extraKeys: string[] = []): Promise<k8s.KubeConfig | undefined> => {
    logger.debug(`Resolver getKubeConfig: clusterUrl=${clusterUrl}${extraKeys.length ? `, extraKeys=[${extraKeys.join(',')}]` : ''}`);
    const knownApi = lookupKnownApiUrl(storedClusters(globalState), clusterUrl, extraKeys);
    return helper.getKubeConfig(clusterUrl, extraKeys, knownApi);
  };
}

/**
 * Creates the findPodAndContainer callback for the DevSpacesResolver.
 */
export function createFindPodAndContainer() {
  return async (
    kubeConfig: k8s.KubeConfig,
    namespace: string,
    devworkspaceId: string
  ): Promise<{ podName: string; containerName: string }> => {
    return findWorkspacePodAndContainer(kubeConfig, namespace, devworkspaceId);
  };
}

/**
 * Creates the checkAndStartWorkspace callback for the DevSpacesResolver.
 */
export function createCheckAndStartWorkspace(
  globalState: { get<T>(key: string): T | undefined },
  tokenManager: TokenManager,
  kubeFactory: KubeClientFactory,
  clusterDiscovery: ClusterDiscovery
) {
  const helper = new KubeAuthHelper(tokenManager, clusterDiscovery, kubeFactory);

  return async (
    clusterUrl: string,
    namespace: string,
    workspaceName: string,
    extraKeys: string[] = []
  ): Promise<'running' | 'started' | 'failed' | 'auth_failed' | 'not_found'> => {
    try {
      const knownApi = lookupKnownApiUrl(storedClusters(globalState), clusterUrl, extraKeys);
      const tokenKeys = knownApi ? [...extraKeys, knownApi] : extraKeys;
      const accessToken = await helper.resolveToken(clusterUrl, tokenKeys);
      if (!accessToken) { return 'auth_failed'; }

      const apiUrl = knownApi || (await clusterDiscovery.discover(clusterUrl)).apiUrl;
      const kubeConfig = kubeFactory.createConfig(apiUrl, accessToken);
      const customApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);

      let dw: DevWorkspaceResource;
      try {
        dw = await customApi.getNamespacedCustomObject({
          group: DW_API_GROUP,
          version: DW_API_VERSION,
          namespace,
          plural: DW_PLURAL,
          name: workspaceName,
        }) as DevWorkspaceResource;
      } catch (fetchErr: any) {
        if (isNotFoundError(fetchErr)) {
          logger.warn(`Workspace ${workspaceName} not found (404) — it may have been deleted`);
          return 'not_found';
        }
        throw fetchErr;
      }

      const phase = dw?.status?.phase;
      logger.info(`Workspace ${workspaceName} phase: ${phase}`);

      if (phase === 'Running') {
        return 'running';
      }

      if (phase === 'Stopped' || phase === 'Failed') {
        logger.info(`Starting workspace ${workspaceName}...`);
        await customApi.patchNamespacedCustomObject({
          group: DW_API_GROUP,
          version: DW_API_VERSION,
          namespace,
          plural: DW_PLURAL,
          name: workspaceName,
          body: [{ op: 'replace', path: '/spec/started', value: true }],
        });

        return await waitForWorkspacePhase(customApi, namespace, workspaceName, 'Running', 300_000)
          ? 'started' : 'failed';
      }

      if (phase === 'Starting') {
        return await waitForWorkspacePhase(customApi, namespace, workspaceName, 'Running', 300_000)
          ? 'running' : 'failed';
      }

      return 'failed';
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes('401') || msg.includes('Unauthorized')) {
        logger.warn('checkAndStartWorkspace: token rejected (401), re-auth needed');
        return 'auth_failed';
      }
      logger.error(`checkAndStartWorkspace failed: ${err}`);
      return 'failed';
    }
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function storedClusters(globalState: { get<T>(key: string): T | undefined }): KnownCluster[] {
  return globalState.get<KnownCluster[]>(CLUSTERS_STATE_KEY) ?? [];
}

/**
 * Detect a 404 Not Found error from the Kubernetes client.
 *
 * The K8s JS client can surface 404 in multiple ways:
 * - err.statusCode = 404 (newer client versions)
 * - err.response.statusCode = 404
 * - err.body.code = 404
 * - err.message contains "HTTP-Code: 404" (older client / string-based errors)
 */
function isNotFoundError(err: any): boolean {
  if (err?.statusCode === 404) { return true; }
  if (err?.response?.statusCode === 404) { return true; }
  if (err?.body?.code === 404) { return true; }
  const msg = err?.message ?? '';
  if (msg.includes('HTTP-Code: 404') || msg.includes('"code":404')) { return true; }
  return false;
}
