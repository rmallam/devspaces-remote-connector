import { clusterIdFromUrl } from './clusterId';

describe('clusterIdFromUrl', () => {
  it('uses the cluster name on a dedicated OpenShift apps domain', () => {
    expect(clusterIdFromUrl('https://devspaces.apps.devspc-1d.zs5b.p1.openshiftapps.com')).toBe('devspc-1d');
    expect(clusterIdFromUrl('https://api.devspc-1d.zs5b.p1.openshiftapps.com:6443')).toBe('devspc-1d');
  });

  it('does not collapse two ROSA clusters onto the shared rosa label', () => {
    const first = 'https://devspaces.apps.rosa.rosa-rwx5g.f8y9.p3.openshiftapps.com';
    const second = 'https://devspaces.apps.rosa.rosa-wfnmw.xvzo.p3.openshiftapps.com';

    expect(clusterIdFromUrl(first)).toBe('rosa-rwx5g');
    expect(clusterIdFromUrl(second)).toBe('rosa-wfnmw');
    expect(clusterIdFromUrl('https://api.rosa-rwx5g.f8y9.p3.openshiftapps.com:6443')).toBe('rosa-rwx5g');
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
