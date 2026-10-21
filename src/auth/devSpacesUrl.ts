/**
 * Resolve the Dev Spaces dashboard URL published by the cluster.
 *
 * Signing in with the API server used to invent `https://devspaces.` plus the
 * apps domain guessed from that API host. A shared ingress publishes the
 * dashboard on a different host. Calls to the guessed host then fail as
 * unauthenticated. The CheCluster route (`status.cheURL`) is the host the
 * gateway actually serves.
 */

export interface CustomObjectListRequest {
  group: string;
  version: string;
  plural: string;
  namespace?: string;
}

export interface CustomObjectReader {
  listClusterCustomObject(request: CustomObjectListRequest): Promise<unknown>;
  listNamespacedCustomObject(request: CustomObjectListRequest & { namespace: string }): Promise<unknown>;
}

export interface DevSpacesUrlSources {
  cheUrls: string[];
  routeHosts: string[];
  consoleLinkHrefs: string[];
}

export type DevSpacesUrlSource = 'che-cluster' | 'route' | 'console-link' | 'fallback';

export interface ChosenDevSpacesUrl {
  url: string;
  source: DevSpacesUrlSource;
}

export async function readDevSpacesUrlSources(
  reader: CustomObjectReader,
  onDebug: (message: string) => void = () => undefined,
): Promise<DevSpacesUrlSources> {
  const cheItems = await tryList(
    () => reader.listClusterCustomObject({
      group: 'org.eclipse.che',
      version: 'v2',
      plural: 'checlusters',
    }),
    (err) => onDebug(`CheCluster lookup failed: ${errorText(err)}`),
  );

  const namespaces = new Set<string>();
  for (const item of cheItems) {
    const namespace = asRecord(asRecord(item).metadata).namespace;
    if (typeof namespace === 'string' && namespace) {
      namespaces.add(namespace);
    }
  }
  if (namespaces.size === 0) {
    namespaces.add('openshift-devspaces');
  }

  const routeHosts: string[] = [];
  for (const namespace of namespaces) {
    const routes = await tryList(
      () => reader.listNamespacedCustomObject({
        group: 'route.openshift.io',
        version: 'v1',
        namespace,
        plural: 'routes',
      }),
      (err) => onDebug(`Route lookup in ${namespace} failed: ${errorText(err)}`),
    );
    routeHosts.push(...routeCandidates(routes));
  }

  const links = await tryList(
    () => reader.listClusterCustomObject({
      group: 'console.openshift.io',
      version: 'v1',
      plural: 'consolelinks',
    }),
    (err) => onDebug(`ConsoleLink lookup failed: ${errorText(err)}`),
  );

  return {
    cheUrls: cheCandidates(cheItems),
    routeHosts,
    consoleLinkHrefs: consoleLinkCandidates(links),
  };
}

/**
 * Pick the dashboard origin to call.
 *
 * CheCluster `status.cheURL` wins, then the Dev Spaces route host, then the
 * OpenShift console link. The fallback is the URL already derived from what
 * the user typed.
 */
export function chooseDevSpacesUrl(sources: DevSpacesUrlSources, fallbackUrl: string): ChosenDevSpacesUrl {
  const che = firstPublicOrigin(sources.cheUrls);
  if (che) {
    return { url: che, source: 'che-cluster' };
  }
  const route = firstPublicOrigin(sources.routeHosts);
  if (route) {
    return { url: route, source: 'route' };
  }
  const link = firstPublicOrigin(sources.consoleLinkHrefs);
  if (link) {
    return { url: link, source: 'console-link' };
  }
  return { url: originKeepingApiHost(fallbackUrl), source: 'fallback' };
}

async function tryList(
  load: () => Promise<unknown>,
  onError: (err: unknown) => void,
): Promise<unknown[]> {
  try {
    return itemsOf(await load());
  } catch (err) {
    onError(err);
    return [];
  }
}

function itemsOf(response: unknown): unknown[] {
  const record = asRecord(response);
  if (Array.isArray(record.items)) {
    return record.items;
  }
  const body = asRecord(record.body);
  if (Array.isArray(body.items)) {
    return body.items;
  }
  return [];
}

function cheCandidates(items: unknown[]): string[] {
  const found: { url: string; rank: number }[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const namespace = asRecord(record.metadata).namespace;
    const url = cheUrl(record);
    if (!url) {
      continue;
    }
    found.push({
      url,
      rank: namespace === 'openshift-devspaces' ? 0 : 1,
    });
  }
  found.sort((left, right) => left.rank - right.rank);
  return found.map((entry) => entry.url);
}

function cheUrl(cluster: Record<string, unknown>): string | undefined {
  const status = asRecord(cluster.status);
  if (typeof status.cheURL === 'string' && status.cheURL.trim()) {
    return status.cheURL.trim();
  }
  const networking = asRecord(asRecord(cluster.spec).networking);
  if (typeof networking.hostname === 'string' && networking.hostname.includes('.')) {
    const hostname = networking.hostname.trim();
    return hostname.includes('://') ? hostname : `https://${hostname}`;
  }
  return undefined;
}

function routeCandidates(items: unknown[]): string[] {
  const found: { host: string; rank: number }[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const name = asRecord(record.metadata).name;
    const host = asRecord(record.spec).host;
    if (typeof host !== 'string' || !host.includes('.')) {
      continue;
    }
    const routeName = typeof name === 'string' ? name : '';
    let rank = 2;
    if (routeName === 'devspaces' || routeName === 'che') {
      rank = 0;
    } else if (host.startsWith('devspaces.') || host.startsWith('che.')) {
      rank = 1;
    } else {
      continue;
    }
    found.push({ host, rank });
  }
  found.sort((left, right) => left.rank - right.rank);
  return found.map((entry) => `https://${entry.host}`);
}

function consoleLinkCandidates(items: unknown[]): string[] {
  const hrefs: string[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const name = asRecord(record.metadata).name;
    const href = asRecord(record.spec).href;
    if (typeof href !== 'string' || !href.trim()) {
      continue;
    }
    const label = `${typeof name === 'string' ? name : ''} ${href}`.toLowerCase();
    if (label.includes('che') || label.includes('devspaces') || label.includes('codeready')) {
      hrefs.push(href.trim());
    }
  }
  return hrefs;
}

function firstPublicOrigin(urls: string[]): string | undefined {
  for (const url of urls) {
    const origin = publicOrigin(url, false);
    if (origin) {
      return origin;
    }
  }
  return undefined;
}

function originKeepingApiHost(url: string): string {
  return publicOrigin(url, true) ?? url.trim().replace(/\/+$/, '');
}

function publicOrigin(url: string, allowApiHost: boolean): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined;
    }
    if (!allowApiHost && parsed.hostname.startsWith('api.')) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
