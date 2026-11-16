import * as vscode from 'vscode';
import { DevSpacesUriHandler, parseHandoffUri } from './DevSpacesUriHandler';
import { ClusterManager } from '../cluster/ClusterManager';
import { ClusterDiscovery } from '../auth/ClusterDiscovery';
import { STATE_ACTIVE_CONNECTION, STATE_CONNECTIONS_MAP } from '../constants';

jest.mock('../commands/workspaceHelpers', () => ({
  copyKiroAuthToPod: jest.fn().mockResolvedValue(undefined),
  discoverProjectFolder: jest.fn().mockResolvedValue('/projects/my-service'),
}));

function makeUri(path: string, query: string): vscode.Uri {
  return {
    scheme: 'vscode',
    authority: 'redhat.devspaces-remote-connector',
    path,
    query,
    toString: () => `vscode://redhat.devspaces-remote-connector${path}?${query}`,
  } as unknown as vscode.Uri;
}

class MemoryState {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }
}

describe('parseHandoffUri', () => {
  it('parses standard self-managed OpenShift handoff URIs', () => {
    const uri = makeUri(
      '/open',
      'dashboardUrl=https%3A%2F%2Fdevspaces.apps.ocp4.corp.example.com&namespace=alice-devspaces&workspace=orders-api&devworkspaceId=workspace123&project=%2Fprojects%2Forders-api'
    );
    expect(parseHandoffUri(uri)).toEqual({
      workspaceName: 'orders-api',
      dashboardUrl: 'https://devspaces.apps.ocp4.corp.example.com',
      apiUrl: undefined,
      namespace: 'alice-devspaces',
      devworkspaceId: 'workspace123',
      projectPath: '/projects/orders-api',
    });
  });

  it('parses custom shared-ingress CNAME + explicit apiUrl handoff URIs', () => {
    const uri = makeUri(
      '/open',
      'dashboardUrl=https%3A%2F%2Fdevspaces.bank.example.com&apiUrl=https%3A%2F%2Fapi.ocp-prod.bank.example.com%3A6443&namespace=team-alpha-r7k2m&workspace=payments'
    );
    expect(parseHandoffUri(uri)).toEqual({
      workspaceName: 'payments',
      dashboardUrl: 'https://devspaces.bank.example.com',
      apiUrl: 'https://api.ocp-prod.bank.example.com:6443',
      namespace: 'team-alpha-r7k2m',
      devworkspaceId: undefined,
      projectPath: undefined,
    });
  });

  it('rejects plain http, localhost SSRF, path traversal, and unsafe workspace names', () => {
    expect(parseHandoffUri(makeUri('/open', 'dashboardUrl=http://devspaces.example.com&workspace=ws'))).toBeUndefined();
    expect(parseHandoffUri(makeUri('/open', 'dashboardUrl=https://localhost:8443&workspace=ws'))).toBeUndefined();
    expect(parseHandoffUri(makeUri('/open', 'dashboardUrl=https://user:pass@devspaces.example.com&workspace=ws'))).toBeUndefined();
    expect(parseHandoffUri(makeUri('/open', 'dashboardUrl=https://devspaces.example.com&workspace=ws;rm+-rf'))).toBeUndefined();

    const traversal = parseHandoffUri(
      makeUri('/open', 'dashboardUrl=https://devspaces.example.com&workspace=ws&project=/projects/../etc/passwd')
    );
    expect(traversal?.projectPath).toBeUndefined();
  });
});

describe('DevSpacesUriHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window as any).withProgress = jest.fn(async (_opts: unknown, task: (p: { report: jest.Mock }) => Promise<unknown>) =>
      task({ report: jest.fn() })
    );
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_k: string, def: unknown) => def),
      update: jest.fn(async () => undefined),
    });
  });

  it('auto-registers a brand-new self-managed OpenShift cluster, authenticates, stores connection state, and opens remote folder', async () => {
    const globalState = new MemoryState();
    const clusterManager = new ClusterManager(globalState as unknown as vscode.Memento);
    const clusterDiscovery = new ClusterDiscovery();
    jest.spyOn(clusterDiscovery, 'discover').mockResolvedValue({
      apiUrl: 'https://api.ocp4.corp.example.com:6443',
      devSpacesUrl: 'https://devspaces.apps.ocp4.corp.example.com',
      oauthAuthorizeUrl: 'https://oauth-openshift.apps.ocp4.corp.example.com/oauth/authorize',
      oauthTokenUrl: 'https://oauth-openshift.apps.ocp4.corp.example.com/oauth/token',
      appsDomain: 'apps.ocp4.corp.example.com',
    });

    const mockCustomApi = {
      getNamespacedCustomObject: jest.fn().mockResolvedValue({
        status: { phase: 'Running', devworkspaceId: 'workspaceabc123' },
        spec: { template: { projects: [{ name: 'my-service', git: { remotes: { origin: 'https://git.corp.example.com/my-service.git' } } }] } },
      }),
      patchNamespacedCustomObject: jest.fn(),
    };
    const kubeClientFactory = {
      createConfig: jest.fn().mockReturnValue({
        getCurrentCluster: () => ({ server: 'https://api.ocp4.corp.example.com:6443' }),
        makeApiClient: () => mockCustomApi,
      }),
    };
    const authProvider = {
      getAccessToken: jest.fn().mockResolvedValue('sha256~oauth-token'), // notsecret
      getEndpoints: jest.fn().mockReturnValue(undefined),
    };

    const handler = new DevSpacesUriHandler({
      context: { globalState, subscriptions: [] } as unknown as vscode.ExtensionContext,
      clusterManager,
      authProvider,
      clusterDiscovery,
      kubeClientFactory: kubeClientFactory as any,
    });

    await handler.handleUri(
      makeUri(
        '/open',
        'dashboardUrl=https%3A%2F%2Fdevspaces.apps.ocp4.corp.example.com&namespace=alice-devspaces-r7k2m&workspace=my-ws'
      )
    );

    expect(clusterManager.getClusters()).toHaveLength(1);
    expect(clusterManager.getClusters()[0].apiUrl).toBe('https://api.ocp4.corp.example.com:6443');

    const activeConn = globalState.get<any>(STATE_ACTIVE_CONNECTION);
    expect(activeConn).toMatchObject({
      workspaceName: 'my-ws',
      namespace: 'alice-devspaces-r7k2m',
      devworkspaceId: 'workspaceabc123',
      hostAlias: 'my-ws@devspaces.apps.ocp4.corp.example.com',
      clusterUrl: 'https://devspaces.apps.ocp4.corp.example.com',
      projectFolder: '/projects/my-service',
    });
    expect(globalState.get<any>(STATE_CONNECTIONS_MAP)['my-ws@devspaces.apps.ocp4.corp.example.com']).toBeDefined();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder',
      expect.objectContaining({
        toString: expect.any(Function),
      }),
      { forceNewWindow: true }
    );
  });
});
