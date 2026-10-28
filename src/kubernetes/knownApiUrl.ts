/** globalState key for the cluster list. Kept in one place with ClusterManager. */
export const CLUSTERS_STATE_KEY = 'devspaces.clusters';

export interface KnownCluster {
  id?: string;
  apiUrl?: string;
  devSpacesUrl?: string;
  appsDomain?: string;
}

/**
 * API server saved at sign-in.
 *
 * Connecting must not derive this again from the dashboard host. A shared
 * ingress puts the dashboard on a different domain than the console and the
 * API, and that lookup hangs or targets a server that does not exist.
 */
export function lookupKnownApiUrl(
  clusters: KnownCluster[] | undefined,
  clusterUrl: string,
  extraKeys: string[] = []
): string | undefined {
  if (!clusters?.length) {
    return undefined;
  }
  const wanted = new Set<string>();
  for (const value of [clusterUrl, ...extraKeys]) {
    for (const key of identityKeys(value)) {
      wanted.add(key);
    }
  }
  for (const cluster of clusters) {
    if (!cluster.apiUrl) {
      continue;
    }
    const fields = [cluster.apiUrl, cluster.devSpacesUrl, cluster.id, cluster.appsDomain];
    for (const field of fields) {
      if (!field) {
        continue;
      }
      for (const key of identityKeys(field)) {
        if (wanted.has(key)) {
          return cluster.apiUrl;
        }
      }
    }
  }
  return undefined;
}

/**
 * Exact keys TokenManager may have used for this cluster.
 *
 * Sign-in stores the OpenShift token under the API URL the user typed. After
 * login the active URL is rewritten to CheCluster `status.cheURL`, which is a
 * different host on a shared ingress. Connect then looks up the token by that
 * dashboard URL and must still find the API-server copy.
 */
export function tokenStorageKeys(
  clusterUrl: string,
  clusters: KnownCluster[] | undefined,
  extraKeys: string[] = [],
): string[] {
  const keys: string[] = [];
  const add = (value?: string) => {
    const trimmed = value?.trim();
    if (trimmed && !keys.includes(trimmed)) {
      keys.push(trimmed);
    }
  };
  add(clusterUrl);
  for (const extra of extraKeys) {
    add(extra);
  }
  const cluster = clusters?.find((entry) => storedUrlNamesCluster(clusterUrl, entry, extraKeys));
  if (cluster) {
    add(cluster.apiUrl);
    add(cluster.devSpacesUrl);
    add(cluster.id);
    add(cluster.appsDomain);
  } else {
    add(lookupKnownApiUrl(clusters, clusterUrl, extraKeys));
  }
  return keys;
}

/**
 * Whether a global cluster URL belongs to this cluster.
 *
 * Several clusters can initialize at once. Only the cluster that owns the
 * stored active URL may replace it with its CheCluster dashboard.
 */
export function storedUrlNamesCluster(
  storedUrl: string | undefined,
  cluster: KnownCluster,
  extraKeys: string[] = [],
): boolean {
  if (!storedUrl?.trim()) {
    return false;
  }
  const wanted = new Set(identityKeys(storedUrl));
  const fields = [cluster.apiUrl, cluster.devSpacesUrl, cluster.id, cluster.appsDomain, ...extraKeys];
  for (const field of fields) {
    if (!field) {
      continue;
    }
    for (const key of identityKeys(field)) {
      if (wanted.has(key)) {
        return true;
      }
    }
  }
  return false;
}

function identityKeys(value: string): string[] {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return [];
  }
  // A cluster id has no dot and no scheme. Do not turn it into a URL.
  if (!trimmed.includes('://') && !trimmed.includes('.')) {
    return [trimmed];
  }
  const keys = [trimmed];
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    keys.push(parsed.origin, parsed.hostname);
  } catch {
    // Keep the raw value.
  }
  return keys;
}
