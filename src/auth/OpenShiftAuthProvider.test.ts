import { OpenShiftAuthProvider } from './OpenShiftAuthProvider';
import { TokenManager } from './TokenManager';
import { CLUSTERS_STATE_KEY } from '../kubernetes/knownApiUrl';
import { STATE_CLUSTER_URL } from '../constants';

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

describe('OpenShiftAuthProvider.getAccessToken', () => {
  const apiUrl = 'https://api.rosa-rwx5g.example.p3.openshiftapps.com:6443';
  const dashboardUrl = 'https://devspaces.apps.shared.example.com';

  it('uses the API-server token after the active URL is rewritten to CheCluster cheURL', async () => {
    const globalState = new MemoryState();
    await globalState.update(STATE_CLUSTER_URL, dashboardUrl);
    await globalState.update(CLUSTERS_STATE_KEY, [{
      id: 'rosa-rwx5g',
      apiUrl,
      devSpacesUrl: dashboardUrl,
      appsDomain: 'apps.rosa.rosa-rwx5g.example.p3.openshiftapps.com',
    }]);

    const tokenManager = new TokenManager(globalState as any);
    await tokenManager.storeToken(apiUrl, {
      accessToken: 'sha256~signed-in-on-api',
      clusterUrl: apiUrl,
      expiresAt: Date.now() + 3600000,
      username: 'alice',
    });

    const provider = new OpenShiftAuthProvider(
      { globalState, subscriptions: [] } as any,
      tokenManager,
      {} as any,
      {} as any,
    );

    await expect(provider.getAccessToken()).resolves.toBe('sha256~signed-in-on-api');
    tokenManager.dispose();
  });

  it('still errors when no alias of the token exists', async () => {
    const globalState = new MemoryState();
    await globalState.update(STATE_CLUSTER_URL, dashboardUrl);

    const tokenManager = new TokenManager(globalState as any);
    const provider = new OpenShiftAuthProvider(
      { globalState, subscriptions: [] } as any,
      tokenManager,
      {} as any,
      {} as any,
    );

    await expect(provider.getAccessToken()).rejects.toThrow('No stored token. Please sign in again.');
    tokenManager.dispose();
  });
});
