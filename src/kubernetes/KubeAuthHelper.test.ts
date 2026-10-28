import { KubeAuthHelper } from './KubeAuthHelper';
import { TokenManager } from '../auth/TokenManager';

class MemoryState {
  private data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }
}

describe('KubeAuthHelper shared-ingress token lookup', () => {
  const apiUrl = 'https://api.cluster.example.com:6443';
  const dashboardUrl = 'https://devspaces.apps.shared.example.com';

  it('builds kubeconfig from the API-server token when the connection URL is the CheCluster host', async () => {
    const tokenManager = new TokenManager(new MemoryState() as any);
    await tokenManager.storeToken(apiUrl, {
      accessToken: 'sha256~from-api',
      clusterUrl: apiUrl,
      expiresAt: Date.now() + 3600000,
    });

    const kubeFactory = { createConfig: jest.fn().mockReturnValue({ kind: 'kc' }) };
    const discovery = {
      extractAppsDomain: jest.fn().mockReturnValue(undefined),
      discover: jest.fn(),
    };
    const helper = new KubeAuthHelper(tokenManager, discovery as any, kubeFactory as any);

    const kc = await helper.getKubeConfig(dashboardUrl, [], apiUrl);

    expect(kc).toEqual({ kind: 'kc' });
    expect(discovery.discover).not.toHaveBeenCalled();
    expect(kubeFactory.createConfig).toHaveBeenCalledWith(apiUrl, 'sha256~from-api');
    tokenManager.dispose();
  });
});
