import { chooseDevSpacesUrl, readDevSpacesUrlSources, CustomObjectReader } from './devSpacesUrl';

const SHARED = 'https://devspaces.apps.shared.example.com';
const DEFAULT_INGRESS = 'https://devspaces.apps.cluster.example.com';

describe('chooseDevSpacesUrl', () => {
  it('keeps the CheCluster host when it is not the ingress guessed from the API', () => {
    const chosen = chooseDevSpacesUrl({
      cheUrls: [`${SHARED}/dashboard/`],
      routeHosts: [SHARED],
      consoleLinkHrefs: [DEFAULT_INGRESS],
    }, DEFAULT_INGRESS);

    expect(chosen).toEqual({ url: SHARED, source: 'che-cluster' });
  });

  it('uses spec.networking.hostname when status.cheURL is empty', () => {
    const chosen = chooseDevSpacesUrl({
      cheUrls: ['https://workspaces.shared.example.com'],
      routeHosts: [],
      consoleLinkHrefs: [],
    }, DEFAULT_INGRESS);

    expect(chosen).toEqual({
      url: 'https://workspaces.shared.example.com',
      source: 'che-cluster',
    });
  });

  it('uses the Dev Spaces route when the CheCluster cannot be read', () => {
    const chosen = chooseDevSpacesUrl({
      cheUrls: [],
      routeHosts: ['https://devspaces.apps.shared.example.com'],
      consoleLinkHrefs: [DEFAULT_INGRESS],
    }, DEFAULT_INGRESS);

    expect(chosen).toEqual({ url: SHARED, source: 'route' });
  });

  it('uses the console link when the route is also unreadable', () => {
    const chosen = chooseDevSpacesUrl({
      cheUrls: [],
      routeHosts: [],
      consoleLinkHrefs: [`${SHARED}/`],
    }, DEFAULT_INGRESS);

    expect(chosen).toEqual({ url: SHARED, source: 'console-link' });
  });

  it('keeps a dashboard URL the user typed when the cluster lookup is empty', () => {
    const chosen = chooseDevSpacesUrl({
      cheUrls: [],
      routeHosts: [],
      consoleLinkHrefs: [],
    }, `${SHARED}/dashboard/#/workspaces`);

    expect(chosen).toEqual({ url: SHARED, source: 'fallback' });
  });

  it('does not treat an API server URL as a dashboard host', () => {
    const chosen = chooseDevSpacesUrl({
      cheUrls: ['https://api.cluster.example.com:6443'],
      routeHosts: [],
      consoleLinkHrefs: [],
    }, DEFAULT_INGRESS);

    expect(chosen).toEqual({ url: DEFAULT_INGRESS, source: 'fallback' });
  });
});

describe('readDevSpacesUrlSources', () => {
  it('reads a shared-ingress CheCluster ahead of a stale console link', async () => {
    const reader = fakeReader({
      checlusters: {
        items: [{
          metadata: { name: 'devspaces', namespace: 'openshift-devspaces' },
          status: { cheURL: `${SHARED}/` },
          spec: { networking: { domain: 'apps.shared.example.com' } },
        }],
      },
      routes: {
        items: [
          { metadata: { name: 'plugin-registry' }, spec: { host: 'plugin-registry.apps.cluster.example.com' } },
          { metadata: { name: 'devspaces' }, spec: { host: 'devspaces.apps.shared.example.com' } },
        ],
      },
      consolelinks: {
        items: [{
          metadata: { name: 'che' },
          spec: { href: DEFAULT_INGRESS },
        }],
      },
    });

    const sources = await readDevSpacesUrlSources(reader);
    expect(sources.cheUrls).toEqual([`${SHARED}/`]);
    expect(sources.routeHosts).toEqual([SHARED]);
    expect(chooseDevSpacesUrl(sources, DEFAULT_INGRESS)).toEqual({
      url: SHARED,
      source: 'che-cluster',
    });
  });

  it('falls through to the console link when CheCluster and routes are forbidden', async () => {
    const reader: CustomObjectReader = {
      listClusterCustomObject: jest.fn(async (request) => {
        if (request.plural === 'checlusters') {
          throw new Error('checlusters is forbidden');
        }
        return {
          items: [{
            metadata: { name: 'che' },
            spec: { href: SHARED },
          }],
        };
      }),
      listNamespacedCustomObject: jest.fn(async () => {
        throw new Error('routes is forbidden');
      }),
    };
    const notes: string[] = [];

    const sources = await readDevSpacesUrlSources(reader, (message) => notes.push(message));

    expect(sources.cheUrls).toEqual([]);
    expect(sources.routeHosts).toEqual([]);
    expect(sources.consoleLinkHrefs).toEqual([SHARED]);
    expect(notes.some((note) => note.includes('CheCluster lookup failed'))).toBe(true);
    expect(chooseDevSpacesUrl(sources, DEFAULT_INGRESS).source).toBe('console-link');
  });

  it('uses hostname when status.cheURL is not set yet', async () => {
    const reader = fakeReader({
      checlusters: {
        items: [{
          metadata: { name: 'devspaces', namespace: 'eclipse-che' },
          spec: { networking: { hostname: 'devspaces.shared.example.com' } },
        }],
      },
      routes: { items: [] },
      consolelinks: { items: [] },
    });

    const sources = await readDevSpacesUrlSources(reader);
    expect(chooseDevSpacesUrl(sources, DEFAULT_INGRESS)).toEqual({
      url: 'https://devspaces.shared.example.com',
      source: 'che-cluster',
    });
  });
});

function fakeReader(lists: {
  checlusters: unknown;
  routes: unknown;
  consolelinks: unknown;
}): CustomObjectReader {
  return {
    listClusterCustomObject: jest.fn(async (request) => {
      if (request.plural === 'checlusters') {
        return lists.checlusters;
      }
      if (request.plural === 'consolelinks') {
        return lists.consolelinks;
      }
      throw new Error(`unexpected list ${request.plural}`);
    }),
    listNamespacedCustomObject: jest.fn(async () => lists.routes),
  };
}
