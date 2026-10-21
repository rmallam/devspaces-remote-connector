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
