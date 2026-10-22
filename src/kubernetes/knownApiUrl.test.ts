import { lookupKnownApiUrl, storedUrlNamesCluster } from './knownApiUrl';

const API = 'https://api.cluster.example.com:6443';
const SHARED = 'https://devspaces.apps.shared.example.com';

describe('lookupKnownApiUrl', () => {
  const clusters = [{
    id: 'cluster',
    apiUrl: API,
    devSpacesUrl: SHARED,
    appsDomain: 'apps.cluster.example.com',
  }];

  it('keeps the API server when the connection URL is the shared dashboard', () => {
    expect(lookupKnownApiUrl(clusters, SHARED)).toBe(API);
  });

  it('matches a cluster id passed as an extra key', () => {
    expect(lookupKnownApiUrl(clusters, 'https://unknown.example.com', ['cluster'])).toBe(API);
  });

  it('returns undefined when the cluster has not stored an API server', () => {
    expect(lookupKnownApiUrl([{ devSpacesUrl: SHARED, apiUrl: '' }], SHARED)).toBeUndefined();
    expect(lookupKnownApiUrl(undefined, SHARED)).toBeUndefined();
  });
});

describe('storedUrlNamesCluster', () => {
  const active = {
    id: 'active',
    apiUrl: API,
    devSpacesUrl: 'https://devspaces.apps.cluster.example.com',
    appsDomain: 'apps.cluster.example.com',
  };
  const other = {
    id: 'other',
    apiUrl: 'https://api.other.example.com:6443',
    devSpacesUrl: 'https://devspaces.apps.other.example.com',
    appsDomain: 'apps.other.example.com',
  };

  it('names the cluster signed in with the API server', () => {
    expect(storedUrlNamesCluster(API, active)).toBe(true);
  });

  it('names the cluster by its shared dashboard', () => {
    expect(storedUrlNamesCluster(SHARED, { ...active, devSpacesUrl: SHARED })).toBe(true);
  });

  it('does not name a different cluster', () => {
    expect(storedUrlNamesCluster(API, other)).toBe(false);
    expect(storedUrlNamesCluster(undefined, active)).toBe(false);
  });
});

describe('stripNavigatorProbe', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { stripNavigatorProbe } = require('../../scripts/strip-navigator-probe');

  it('removes the navigator read from oauth library startup', () => {
    const source = "if (typeof navigator === 'undefined' || !navigator.userAgent?.startsWith?.('Mozilla/5.0 ')) {\n  USER_AGENT = 'oauth4webapi/v3.8.6';\n}";
    const updated = stripNavigatorProbe(source);
    expect(updated).not.toContain('navigator');
    expect(updated.startsWith('if (true) {')).toBe(true);
  });
});
