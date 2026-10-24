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

  it('keeps two ROSA clusters instead of updating the first', async () => {
    const manager = new ClusterManager(new MemoryState() as unknown as vscode.Memento);
    const first = await manager.addCluster('https://api.rosa-rwx5g.f8y9.p3.openshiftapps.com:6443');
    const second = await manager.addCluster('https://api.rosa-wfnmw.xvzo.p3.openshiftapps.com:6443');

    expect(first.id).toBe('rosa-rwx5g');
    expect(second.id).toBe('rosa-wfnmw');
    expect(first.displayName).toBe('devspaces@rosa-rwx5g');
    expect(second.displayName).toBe('devspaces@rosa-wfnmw');
    expect(manager.getClusters().map((cluster) => cluster.id)).toEqual(['rosa-rwx5g', 'rosa-wfnmw']);
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

  it('returns the existing entry when the same cluster is added again', async () => {
    const manager = new ClusterManager(new MemoryState() as unknown as vscode.Memento);
    const first = await manager.addCluster('https://devspaces.apps.devspc-1d.zs5b.p1.openshiftapps.com');
    const again = await manager.addCluster('https://api.devspc-1d.zs5b.p1.openshiftapps.com:6443');

    expect(again.id).toBe(first.id);
    expect(manager.getClusters()).toHaveLength(1);
  });
});
