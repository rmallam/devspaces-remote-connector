import { ClusterDiscovery } from './ClusterDiscovery';

describe('ClusterDiscovery', () => {
  let discovery: ClusterDiscovery;

  beforeEach(() => {
    discovery = new ClusterDiscovery();
  });

  describe('extractAppsDomain', () => {
    it('extracts apps domain from devspaces URL', () => {
      expect(discovery.extractAppsDomain('https://devspaces.apps.mycluster-01.abc1.p1.openshiftapps.com'))
        .toBe('apps.mycluster-01.abc1.p1.openshiftapps.com');
    });

    it('extracts apps domain from console URL', () => {
      expect(discovery.extractAppsDomain('https://console-openshift-console.apps.mycluster-01.abc1.p1.openshiftapps.com'))
        .toBe('apps.mycluster-01.abc1.p1.openshiftapps.com');
    });

    it('extracts apps domain from API URL', () => {
      expect(discovery.extractAppsDomain('https://api.mycluster-01.abc1.p1.openshiftapps.com:6443'))
        .toBe('apps.mycluster-01.abc1.p1.openshiftapps.com');
    });

    it('handles URL with path and fragment', () => {
      expect(discovery.extractAppsDomain('https://devspaces.apps.cluster.example.com/dashboard/#/workspaces'))
        .toBe('apps.cluster.example.com');
    });

    it('handles direct apps domain', () => {
      expect(discovery.extractAppsDomain('https://apps.cluster.example.com'))
        .toBe('apps.cluster.example.com');
    });

    it('returns undefined for CNAME alias without apps pattern', () => {
      expect(discovery.extractAppsDomain('https://devspaces.mycompany.com'))
        .toBeUndefined();
    });

    it('returns undefined for invalid URL', () => {
      expect(discovery.extractAppsDomain('not-a-url'))
        .toBeUndefined();
    });

    it('handles URL with port in apps pattern', () => {
      expect(discovery.extractAppsDomain('https://devspaces.apps.cluster.example.com:8443'))
        .toBe('apps.cluster.example.com');
    });
  });

  describe('normalizeInputUrl', () => {
    it('adds https:// if missing', () => {
      expect(discovery.normalizeInputUrl('devspaces.apps.cluster.example.com'))
        .toBe('https://devspaces.apps.cluster.example.com');
    });

    it('preserves existing https://', () => {
      expect(discovery.normalizeInputUrl('https://devspaces.apps.cluster.example.com'))
        .toBe('https://devspaces.apps.cluster.example.com');
    });

    it('strips trailing slashes and paths', () => {
      expect(discovery.normalizeInputUrl('https://devspaces.apps.cluster.example.com/dashboard/'))
        .toBe('https://devspaces.apps.cluster.example.com');
    });

    it('trims whitespace', () => {
      expect(discovery.normalizeInputUrl('  https://devspaces.apps.cluster.example.com  '))
        .toBe('https://devspaces.apps.cluster.example.com');
    });

    it('preserves port', () => {
      expect(discovery.normalizeInputUrl('https://api.cluster.example.com:6443'))
        .toBe('https://api.cluster.example.com:6443');
    });
  });

  describe('buildDevSpacesUrl', () => {
    it('keeps a dashboard URL on a shared ingress', () => {
      expect(discovery.buildDevSpacesUrl('https://devspaces.apps.shared.example.com/dashboard/'))
        .toBe('https://devspaces.apps.shared.example.com');
    });

    it('keeps a devspaces URL that already uses the apps domain', () => {
      expect(discovery.buildDevSpacesUrl('https://devspaces.apps.mycluster-01.abc1.p1.openshiftapps.com'))
        .toBe('https://devspaces.apps.mycluster-01.abc1.p1.openshiftapps.com');
    });

    it('does not use an API server URL as the dashboard', () => {
      expect(discovery.buildDevSpacesUrl('https://api.cluster.example.com:6443'))
        .toBe('https://devspaces.apps.cluster.example.com');
    });

    it('inserts the ROSA apps label when guessing from an API URL', () => {
      expect(discovery.buildDevSpacesUrl('https://api.mycluster-01.abc1.p1.openshiftapps.com:443'))
        .toBe('https://devspaces.apps.rosa.mycluster-01.abc1.p1.openshiftapps.com');
    });

    it('still inserts the ROSA apps label when the cluster name starts with rosa-', () => {
      expect(discovery.buildDevSpacesUrl('https://api.rosa-example.f8y9.p3.openshiftapps.com:443'))
        .toBe('https://devspaces.apps.rosa.rosa-example.f8y9.p3.openshiftapps.com');
    });
  });

  describe('resolveApiUrl', () => {
    it('keeps the API server URL the user typed', () => {
      expect(discovery.resolveApiUrl(
        'https://api.cluster.example.com:6443',
        'https://api.cluster.example.com:443',
      )).toBe('https://api.cluster.example.com:6443');
    });

    it('uses the discovered API server for a dashboard URL', () => {
      expect(discovery.resolveApiUrl(
        'https://devspaces.apps.shared.example.com',
        'https://api.cluster.example.com:6443',
      )).toBe('https://api.cluster.example.com:6443');
    });
  });
});
