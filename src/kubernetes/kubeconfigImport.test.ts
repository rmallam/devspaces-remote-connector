import * as k8s from '@kubernetes/client-node';
import { readCurrentKubeconfigSession, verifyOpenShiftToken } from './kubeconfigImport';
import * as httpClient from '../util/httpClient';

jest.mock('../util/httpClient', () => ({
  getJson: jest.fn(),
}));

describe('kubeconfigImport', () => {
  it('extracts active https server and token from default kubeconfig', () => {
    (k8s.KubeConfig as unknown as jest.Mock).mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      getCurrentCluster: () => ({ server: 'https://api.rosa-rwx5g.f8y9.p3.openshiftapps.com:443/' }),
      getCurrentUser: () => ({ token: 'sha256~testtoken' }), // notsecret
      getCurrentContext: () => 'default/api-rosa-rwx5g/cluster-admin',
    }));

    expect(readCurrentKubeconfigSession()).toEqual({
      apiUrl: 'https://api.rosa-rwx5g.f8y9.p3.openshiftapps.com:443',
      token: 'sha256~testtoken', // notsecret
      contextName: 'default/api-rosa-rwx5g/cluster-admin',
    });
  });

  it('rejects non-https kubeconfig servers', () => {
    (k8s.KubeConfig as unknown as jest.Mock).mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      getCurrentCluster: () => ({ server: 'http://localhost:8080' }),
      getCurrentUser: () => ({}),
      getCurrentContext: () => 'local',
    }));

    expect(readCurrentKubeconfigSession()).toBeUndefined();
  });

  it('verifies OpenShift token via /apis/user.openshift.io/v1/users/~', async () => {
    (httpClient.getJson as jest.Mock).mockResolvedValueOnce({
      metadata: { name: 'cluster-admin' },
    });

    await expect(
      verifyOpenShiftToken('https://api.rosa-rwx5g.f8y9.p3.openshiftapps.com:443', 'sha256~testtoken'), // notsecret
    ).resolves.toBe('cluster-admin');
  });
});
