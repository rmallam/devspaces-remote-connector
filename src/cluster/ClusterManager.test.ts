import * as vscode from 'vscode';
import { ClusterManager } from './ClusterManager';

class MemoryState {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

describe('ClusterManager.addCluster', () => {
  beforeEach(() => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
      update: jest.fn(async () => undefined),
    });
  });

  it('keeps two clusters that share an ingress sub-label instead of updating the first', async () => {
    const manager = new ClusterManager(new MemoryState() as unknown as vscode.Memento);
    const first = await manager.addCluster('https://api.cluster-a.f8y9.p3.openshiftapps.com:6443');
    const second = await manager.addCluster('https://api.cluster-b.xvzo.p3.openshiftapps.com:6443');

    expect(first.id).toBe('cluster-a');
    expect(second.id).toBe('cluster-b');
    expect(first.apiUrl).toBe('https://api.cluster-a.f8y9.p3.openshiftapps.com:6443');
    expect(second.apiUrl).toBe('https://api.cluster-b.xvzo.p3.openshiftapps.com:6443');
    expect(first.displayName).toBe('devspaces@cluster-a');
    expect(second.displayName).toBe('devspaces@cluster-b');
    expect(manager.getClusters().map((cluster) => cluster.id)).toEqual(['cluster-a', 'cluster-b']);
  });

  it('keeps two shared-ingress dashboards as separate clusters', async () => {
    const manager = new ClusterManager(new MemoryState() as unknown as vscode.Memento);
    await manager.addCluster('https://devspaces.apps.shared.dc1.example.com');
    await manager.addCluster('https://devspaces.apps.shared.dc2.example.com');

    expect(manager.getClusters().map((cluster) => cluster.id)).toEqual([
      'devspaces.apps.shared.dc1.example.com',
      'devspaces.apps.shared.dc2.example.com',
    ]);
  });

  it('returns the existing entry and records apiUrl when the same cluster is added again via API URL', async () => {
    const manager = new ClusterManager(new MemoryState() as unknown as vscode.Memento);
    const first = await manager.addCluster('https://devspaces.apps.devspc-1d.zs5b.p1.openshiftapps.com');
    const again = await manager.addCluster('https://api.devspc-1d.zs5b.p1.openshiftapps.com:6443');

    expect(again.id).toBe(first.id);
    expect(again.apiUrl).toBe('https://api.devspc-1d.zs5b.p1.openshiftapps.com:6443');
    expect(manager.getClusters()).toHaveLength(1);
  });

  it('removes settings entry even after devSpacesUrl is updated to a shared-ingress CheCluster URL', async () => {
    let settingsClusters: string[] = [];
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn(() => settingsClusters),
      update: jest.fn(async (_key: string, val: string[]) => {
        settingsClusters = val;
      }),
    });

    const manager = new ClusterManager(new MemoryState() as unknown as vscode.Memento);
    const entry = await manager.addCluster('https://api.cluster.example.com:6443');
    await manager.updateCluster(entry.id, {
      apiUrl: 'https://api.cluster.example.com:6443',
      devSpacesUrl: 'https://devspaces.apps.shared.example.com',
      appsDomain: 'apps.cluster.example.com',
    });

    expect(manager.getClusters()[0].displayName).toBe('devspaces.apps.shared.example.com');
    expect(manager.getClusters()[0].devSpacesUrl).toBe('https://devspaces.apps.shared.example.com');

    await manager.removeCluster(entry.id);
    expect(settingsClusters).toEqual([]);
  });
});
