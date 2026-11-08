import { clusterIdFromUrl } from './clusterId';

describe('clusterIdFromUrl', () => {
  it('uses the cluster name on a dedicated OpenShift apps domain', () => {
    expect(clusterIdFromUrl('https://devspaces.apps.devspc-1d.zs5b.p1.openshiftapps.com')).toBe('devspc-1d');
    expect(clusterIdFromUrl('https://api.devspc-1d.zs5b.p1.openshiftapps.com:6443')).toBe('devspc-1d');
  });

  it('does not collapse two clusters that share an ingress sub-label under apps.', () => {
    const first = 'https://devspaces.apps.shared.cluster-a.f8y9.p3.openshiftapps.com';
    const second = 'https://devspaces.apps.shared.cluster-b.xvzo.p3.openshiftapps.com';

    expect(clusterIdFromUrl(first)).toBe('cluster-a');
    expect(clusterIdFromUrl(second)).toBe('cluster-b');
    expect(clusterIdFromUrl('https://api.cluster-a.f8y9.p3.openshiftapps.com:6443')).toBe('cluster-a');
  });

  it('keeps two shared-ingress dashboards as different clusters', () => {
    const first = 'https://devspaces.apps.shared.dc1.example.com';
    const second = 'https://devspaces.apps.shared.dc2.example.com';

    expect(clusterIdFromUrl(first)).toBe('devspaces.apps.shared.dc1.example.com');
    expect(clusterIdFromUrl(second)).toBe('devspaces.apps.shared.dc2.example.com');
    expect(clusterIdFromUrl(first)).not.toBe(clusterIdFromUrl(second));
  });

  it('keeps a plain hostname as its own id', () => {
    expect(clusterIdFromUrl('https://devspaces.example.com/dashboard')).toBe('devspaces.example.com');
  });
});
