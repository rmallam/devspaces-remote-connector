import { OpenShiftAuthProvider } from './OpenShiftAuthProvider';
import { TokenManager } from './TokenManager';
import { CLUSTERS_STATE_KEY } from '../kubernetes/knownApiUrl';
import { STATE_CLUSTER_URL } from '../constants';

jest.mock('../util/httpClient', () => ({
  getJson: jest.fn().mockResolvedValue({ metadata: { name: 'alice' } }),
}));

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
  const endpoints = {
    apiUrl,
    oauthAuthorizeUrl: `${apiUrl}/oauth/authorize`,
    oauthTokenUrl: `${apiUrl}/oauth/token`,
    devSpacesUrl: dashboardUrl,
    appsDomain: 'apps.rosa.rosa-rwx5g.example.p3.openshiftapps.com',
  };

  async function seedCluster(globalState: MemoryState): Promise<void> {
    await globalState.update(STATE_CLUSTER_URL, dashboardUrl);
    await globalState.update(CLUSTERS_STATE_KEY, [{
      id: 'rosa-rwx5g',
      apiUrl,
      devSpacesUrl: dashboardUrl,
      appsDomain: endpoints.appsDomain,
    }]);
  }

  it('uses the API-server token after the active URL is rewritten to CheCluster cheURL', async () => {
    const globalState = new MemoryState();
    await seedCluster(globalState);

    const tokenManager = new TokenManager(globalState as any);
    await tokenManager.storeToken(apiUrl, {
      accessToken: 'sha256~signed-in-on-api', // notsecret — test fixture only
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

    await expect(provider.getAccessToken()).resolves.toBe('sha256~signed-in-on-api'); // notsecret
    tokenManager.dispose();
  });

  it('starts browser sign-in when no valid token exists instead of telling the user to Clear Auth', async () => {
    const globalState = new MemoryState();
    await seedCluster(globalState);

    const tokenManager = new TokenManager(globalState as any);
    const oauthFlow = {
      execute: jest.fn().mockResolvedValue({
        accessToken: 'sha256~from-relogin', // notsecret — test fixture only
        expiresIn: 3600,
      }),
    };
    const clusterDiscovery = {
      discover: jest.fn().mockResolvedValue(endpoints),
    };

    const provider = new OpenShiftAuthProvider(
      { globalState, subscriptions: [] } as any,
      tokenManager,
      oauthFlow as any,
      clusterDiscovery as any,
    );

    await expect(provider.getAccessToken()).resolves.toBe('sha256~from-relogin'); // notsecret
    expect(oauthFlow.execute).toHaveBeenCalled();
    expect(clusterDiscovery.discover).toHaveBeenCalledWith(apiUrl);
    tokenManager.dispose();
  });

  it('restores OAuth endpoints on activation even when the stored token is already expired', async () => {
    const globalState = new MemoryState();
    await seedCluster(globalState);

    const tokenManager = new TokenManager(globalState as any);
    await tokenManager.storeToken(apiUrl, {
      accessToken: 'sha256~expired', // notsecret — test fixture only
      clusterUrl: apiUrl,
      expiresAt: Date.now() - 60_000,
      username: 'alice',
    });

    const clusterDiscovery = {
      discover: jest.fn().mockResolvedValue(endpoints),
    };

    const provider = new OpenShiftAuthProvider(
      { globalState, subscriptions: [] } as any,
      tokenManager,
      {} as any,
      clusterDiscovery as any,
    );

    await provider.initializeFromStored();

    expect(clusterDiscovery.discover).toHaveBeenCalledWith(apiUrl);
    expect(provider.getEndpoints()).toEqual(endpoints);
    tokenManager.dispose();
  });
});
