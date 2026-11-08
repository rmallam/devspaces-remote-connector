import * as k8s from '@kubernetes/client-node';
import { getJson } from '../util/httpClient';

export interface KubeconfigSession {
  apiUrl: string;
  token?: string;
  contextName?: string;
}

/**
 * Inspect the user's local kubeconfig (e.g. from `oc login`) for an active cluster server and token.
 */
export function readCurrentKubeconfigSession(): KubeconfigSession | undefined {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const cluster = kc.getCurrentCluster();
    if (!cluster?.server) {
      return undefined;
    }
    const parsed = new URL(cluster.server);
    if (parsed.protocol !== 'https:') {
      return undefined;
    }
    const user = kc.getCurrentUser();
    const contextName = kc.getCurrentContext();
    return {
      apiUrl: cluster.server.replace(/\/+$/, ''),
      token: user?.token || undefined,
      contextName: contextName || undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Verify whether a kubeconfig bearer token is valid against the OpenShift Users API.
 */
export async function verifyOpenShiftToken(apiUrl: string, token: string): Promise<string | undefined> {
  try {
    const user = await getJson<{ metadata?: { name?: string } }>(
      `${apiUrl.replace(/\/+$/, '')}/apis/user.openshift.io/v1/users/~`,
      { Authorization: `Bearer ${token}` },
    );
    return user.metadata?.name;
  } catch {
    return undefined;
  }
}
