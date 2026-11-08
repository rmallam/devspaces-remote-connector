/**
 * Stable cluster id for a dashboard or API URL.
 *
 * A standard OpenShift domain uses the cluster name
 * (`devspaces.apps.devspc-1d.<shard>.p1.openshiftapps.com` → `devspc-1d`,
 * `api.devspc-1d.<shard>.p1.openshiftapps.com` → `devspc-1d`).
 * When a shared ingress adds a sub-label under `apps.` on a managed domain
 * (`devspaces.apps.<ingress>.<cluster>.<shard>.p3.openshiftapps.com`), the
 * cluster name is still `<cluster>` rather than the shared `<ingress>` label.
 * Any other host, including clusters behind a custom shared ingress domain,
 * keeps the full hostname so separate clusters do not collapse onto one id.
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

  const appsMatch = hostname.match(/(?:^|\.)apps\.(?:[^.]+\.)?([^.]+)\.[^.]+\.p\d+\.openshiftapps\.com$/);
  if (appsMatch) {
    return appsMatch[1];
  }

  const api = hostname.match(/^api\.([^.]+)\.[^.]+\.p\d+\.openshiftapps\.com$/);
  if (api) {
    return api[1];
  }

  return hostname;
}

