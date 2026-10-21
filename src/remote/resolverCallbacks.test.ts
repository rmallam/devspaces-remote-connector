import { createGetKubeConfig, createCheckAndStartWorkspace } from './resolverCallbacks';
import { TokenManager, StoredToken } from '../auth/TokenManager';

// Mock Logger
jest.mock('../util/Logger', () => ({
  Logger: { getInstance: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
}));

// Mock KubeAuthHelper
jest.mock('../kubernetes/KubeAuthHelper', () => ({
  KubeAuthHelper: jest.fn().mockImplementation(function (this: any, tokenManager: any, clusterDiscovery: any, kubeFactory: any) {
    this.tokenManager = tokenManager;
    this.clusterDiscovery = clusterDiscovery;
    this.kubeFactory = kubeFactory;
    this.resolveToken = jest.fn(async (clusterUrl: string, extraKeys: string[] = []) => {
      const keysToTry = [clusterUrl, ...extraKeys];
      for (const key of keysToTry) {
        const storedToken = await tokenManager.getToken(key);
        if (storedToken && tokenManager.isTokenValid(storedToken)) {
          return storedToken.accessToken;
        }
      }
      return undefined;
    });
    this.getKubeConfig = jest.fn(async (clusterUrl: string, extraKeys: string[] = []) => {
      const token = await this.resolveToken(clusterUrl, extraKeys);
      if (!token) { return undefined; }
      try {
        const endpoints = await clusterDiscovery.discover(clusterUrl);
        return kubeFactory.createConfig(endpoints.apiUrl, token);
      } catch { return undefined; }
    });
  }),
  findWorkspacePodAndContainer: jest.fn(),
  waitForWorkspacePhase: jest.fn(),
}));

describe('resolverCallbacks', () => {
  describe('createGetKubeConfig', () => {
    let mockGlobalState: { get: jest.Mock };
    let mockTokenManager: jest.Mocked<Pick<TokenManager, 'getToken' | 'isTokenValid'>>;
    let mockKubeFactory: { createConfig: jest.Mock };
    let mockClusterDiscovery: { discover: jest.Mock; extractAppsDomain: jest.Mock };

    beforeEach(() => {
      mockGlobalState = { get: jest.fn() };
      mockTokenManager = {
        getToken: jest.fn(),
        isTokenValid: jest.fn(),
      };
      mockKubeFactory = { createConfig: jest.fn().mockReturnValue({}) };
      mockClusterDiscovery = {
        discover: jest.fn().mockResolvedValue({
          apiUrl: 'https://api.cluster.example.com:6443',
          devSpacesUrl: 'https://devspaces.apps.cluster.example.com',
          oauthAuthorizeUrl: 'https://oauth.example.com/authorize',
          oauthTokenUrl: 'https://oauth.example.com/token',
          appsDomain: 'apps.cluster.example.com',
        }),
        extractAppsDomain: jest.fn().mockReturnValue('apps.cluster.example.com'),
      };
    });

    it('uses token from TokenManager when valid', async () => {
      const token: StoredToken = { accessToken: 'sha256~valid', clusterUrl: 'https://cluster.example.com', expiresAt: Date.now() + 3600000 };
      mockTokenManager.getToken.mockResolvedValue(token);
      mockTokenManager.isTokenValid.mockReturnValue(true);

      const getKubeConfig = createGetKubeConfig(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      await getKubeConfig('https://cluster.example.com');

      expect(mockKubeFactory.createConfig).toHaveBeenCalledWith('https://api.cluster.example.com:6443', 'sha256~valid');
    });

    it('returns undefined when no token available', async () => {
      mockTokenManager.getToken.mockResolvedValue(undefined);

      const getKubeConfig = createGetKubeConfig(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await getKubeConfig('https://cluster.example.com');

      expect(result).toBeUndefined();
      expect(mockKubeFactory.createConfig).not.toHaveBeenCalled();
    });

    it('returns undefined when discovery fails', async () => {
      mockTokenManager.getToken.mockResolvedValue({ accessToken: 'sha256~valid', clusterUrl: 'x', expiresAt: Date.now() + 3600000 });
      mockTokenManager.isTokenValid.mockReturnValue(true);
      mockClusterDiscovery.discover.mockRejectedValue(new Error('network error'));

      const getKubeConfig = createGetKubeConfig(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await getKubeConfig('https://cluster.example.com');

      expect(result).toBeUndefined();
    });

    it('passes extraKeys to the helper for token lookup', async () => {
      const token: StoredToken = { accessToken: 'sha256~extra', clusterUrl: 'https://cluster.example.com', expiresAt: Date.now() + 3600000 };
      // First call (primary key) returns nothing, second (extra key) returns token
      mockTokenManager.getToken
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(token);
      mockTokenManager.isTokenValid.mockReturnValue(true);

      const getKubeConfig = createGetKubeConfig(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await getKubeConfig('https://cluster.example.com', ['my-cluster-id']);

      expect(result).toBeDefined();
      expect(mockKubeFactory.createConfig).toHaveBeenCalledWith('https://api.cluster.example.com:6443', 'sha256~extra');
    });
  });

  describe('createCheckAndStartWorkspace', () => {
    let mockGlobalState: { get: jest.Mock };
    let mockTokenManager: jest.Mocked<Pick<TokenManager, 'getToken' | 'isTokenValid'>>;
    let mockKubeFactory: { createConfig: jest.Mock };
    let mockClusterDiscovery: { discover: jest.Mock; extractAppsDomain: jest.Mock };
    let mockCustomApi: { getNamespacedCustomObject: jest.Mock; patchNamespacedCustomObject: jest.Mock };

    beforeEach(() => {
      mockGlobalState = { get: jest.fn() };
      mockTokenManager = {
        getToken: jest.fn().mockResolvedValue({ accessToken: 'sha256~token', clusterUrl: 'https://cluster.example.com', expiresAt: Date.now() + 3600000 }),
        isTokenValid: jest.fn().mockReturnValue(true),
      };
      mockCustomApi = {
        getNamespacedCustomObject: jest.fn(),
        patchNamespacedCustomObject: jest.fn(),
      };
      mockKubeFactory = {
        createConfig: jest.fn().mockReturnValue({
          makeApiClient: jest.fn().mockReturnValue(mockCustomApi),
        }),
      };
      mockClusterDiscovery = {
        discover: jest.fn().mockResolvedValue({
          apiUrl: 'https://api.cluster.example.com:6443',
          devSpacesUrl: 'https://devspaces.apps.cluster.example.com',
          oauthAuthorizeUrl: 'https://oauth.example.com/authorize',
          oauthTokenUrl: 'https://oauth.example.com/token',
          appsDomain: 'apps.cluster.example.com',
        }),
        extractAppsDomain: jest.fn().mockReturnValue('apps.cluster.example.com'),
      };
    });

    it('uses the stored API server for a shared-ingress dashboard', async () => {
      mockGlobalState.get.mockReturnValue([{
        id: 'shared',
        apiUrl: 'https://api.real.example.com:6443',
        devSpacesUrl: 'https://devspaces.apps.shared.example.com',
        appsDomain: 'apps.real.example.com',
      }]);
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ status: { phase: 'Running' } });

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://devspaces.apps.shared.example.com', 'user-devspaces', 'empty');

      expect(result).toBe('running');
      expect(mockClusterDiscovery.discover).not.toHaveBeenCalled();
      expect(mockKubeFactory.createConfig).toHaveBeenCalledWith('https://api.real.example.com:6443', 'sha256~token');
    });

    it('returns auth_failed when no token available', async () => {
      mockTokenManager.getToken.mockResolvedValue(undefined);
      mockTokenManager.isTokenValid.mockReturnValue(false);

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('auth_failed');
    });

    it('returns auth_failed on 401 Unauthorized', async () => {
      mockCustomApi.getNamespacedCustomObject.mockRejectedValue(new Error('HTTP-Code: 401\nMessage: Unauthorized'));

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('auth_failed');
    });

    it('returns running when workspace is Running', async () => {
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ status: { phase: 'Running' } });

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('running');
    });

    it('returns failed on non-auth errors', async () => {
      mockCustomApi.getNamespacedCustomObject.mockRejectedValue(new Error('HTTP-Code: 500\nMessage: Internal Server Error'));

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('failed');
    });

    it('returns not_found when workspace returns 404 via statusCode property', async () => {
      const notFoundErr: any = new Error('not found');
      notFoundErr.statusCode = 404;
      mockCustomApi.getNamespacedCustomObject.mockRejectedValue(notFoundErr);

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'my-deleted-ws');

      expect(result).toBe('not_found');
    });

    it('returns not_found when workspace returns 404 via response.statusCode', async () => {
      const notFoundErr: any = new Error('not found');
      notFoundErr.response = { statusCode: 404 };
      mockCustomApi.getNamespacedCustomObject.mockRejectedValue(notFoundErr);

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'deleted-ws');

      expect(result).toBe('not_found');
    });

    it('returns not_found when workspace returns 404 via body.code', async () => {
      const notFoundErr: any = new Error('not found');
      notFoundErr.body = { code: 404, message: 'devworkspaces.workspace.devfile.io "ws" not found' };
      mockCustomApi.getNamespacedCustomObject.mockRejectedValue(notFoundErr);

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('not_found');
    });

    it('returns not_found when error message contains HTTP-Code: 404', async () => {
      const notFoundErr = new Error('HTTP-Code: 404\nMessage: Unknown API Status Code!\nBody: "..."');
      mockCustomApi.getNamespacedCustomObject.mockRejectedValue(notFoundErr);

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'deleted-ws');

      expect(result).toBe('not_found');
    });

    it('returns not_found when error message contains "code":404 in JSON body', async () => {
      const notFoundErr = new Error('{"kind":"Status","apiVersion":"v1","status":"Failure","message":"not found","code":404}');
      mockCustomApi.getNamespacedCustomObject.mockRejectedValue(notFoundErr);

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('not_found');
    });

    it('starts a Stopped workspace and waits for Running', async () => {
      const { waitForWorkspacePhase } = require('../kubernetes/KubeAuthHelper');
      waitForWorkspacePhase.mockResolvedValue(true);
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ status: { phase: 'Stopped' } });
      mockCustomApi.patchNamespacedCustomObject.mockResolvedValue({});

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('started');
      expect(mockCustomApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          body: [{ op: 'replace', path: '/spec/started', value: true }],
        })
      );
    });

    it('starts a Failed workspace and waits for Running', async () => {
      const { waitForWorkspacePhase } = require('../kubernetes/KubeAuthHelper');
      waitForWorkspacePhase.mockResolvedValue(true);
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ status: { phase: 'Failed' } });
      mockCustomApi.patchNamespacedCustomObject.mockResolvedValue({});

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('started');
    });

    it('returns failed if a Stopped workspace does not reach Running within timeout', async () => {
      const { waitForWorkspacePhase } = require('../kubernetes/KubeAuthHelper');
      waitForWorkspacePhase.mockResolvedValue(false);
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ status: { phase: 'Stopped' } });
      mockCustomApi.patchNamespacedCustomObject.mockResolvedValue({});

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('failed');
    });

    it('waits for a Starting workspace to reach Running', async () => {
      const { waitForWorkspacePhase } = require('../kubernetes/KubeAuthHelper');
      waitForWorkspacePhase.mockResolvedValue(true);
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ status: { phase: 'Starting' } });

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('running');
      expect(mockCustomApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
    });

    it('returns failed when Starting workspace times out', async () => {
      const { waitForWorkspacePhase } = require('../kubernetes/KubeAuthHelper');
      waitForWorkspacePhase.mockResolvedValue(false);
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ status: { phase: 'Starting' } });

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('failed');
    });

    it('returns failed for an unknown phase', async () => {
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ status: { phase: 'Terminating' } });

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('failed');
    });

    it('returns failed when workspace has no status', async () => {
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({});

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      const result = await check('https://cluster.example.com', 'ns', 'ws');

      expect(result).toBe('failed');
    });

    it('passes extraKeys to token resolution', async () => {
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ status: { phase: 'Running' } });

      const check = createCheckAndStartWorkspace(mockGlobalState, mockTokenManager as any, mockKubeFactory as any, mockClusterDiscovery as any);
      await check('https://cluster.example.com', 'ns', 'ws', ['cluster-id-123']);

      // Token resolution should succeed (no auth_failed) since token is configured in beforeEach
      expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalled();
    });
  });
});
