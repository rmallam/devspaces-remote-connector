/**
 * Stable cluster id for a dashboard or API URL.
 *
 * A dedicated OpenShift apps domain uses the cluster name
 * (`devspaces.apps.devspc-1d.<shard>.p1.openshiftapps.com` → `devspc-1d`).
 * ROSA inserts a shared `rosa` label in front of that name
 * (`devspaces.apps.rosa.rosa-rwx5g.<shard>.p3.openshiftapps.com` → `rosa-rwx5g`).
 * Any other host, including two clusters behind one shared ingress, keeps
 * the full hostname so they are not stored as the same cluster.
 */
export function clusterIdFromUrl(url: string): string {
  let hostname = url.trim();
  try {
    if (!/^https?:\/\//i.test(hostname)) {
      hostname = `https://${hostname}`;
    }
    hostname = new URL(hostname).hostname.toLowerCase();
  } catch {
    return url;
  }

  const rosa = hostname.match(/(?:^|\.)apps\.rosa\.([^.]+)\.[^.]+\.p\d+\.openshiftapps\.com$/);
  if (rosa) {
    return rosa[1];
  }

  const dedicated = hostname.match(/(?:^|\.)apps\.([^.]+)\.[^.]+\.p\d+\.openshiftapps\.com$/);
  if (dedicated) {
    return dedicated[1];
  }

  const api = hostname.match(/^api\.([^.]+)\.[^.]+\.p\d+\.openshiftapps\.com$/);
  if (api) {
    return api[1];
  }

  return hostname;
}
