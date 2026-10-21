import { lookupKnownApiUrl } from './knownApiUrl';

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
