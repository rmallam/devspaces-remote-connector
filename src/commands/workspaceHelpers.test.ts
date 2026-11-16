import { discoverProjectFolder } from './workspaceHelpers';
import { execOnPod } from '../kubernetes/execHelper';
import { WorkspacePhase } from '../constants';

jest.mock('../kubernetes/execHelper', () => ({
  execOnPod: jest.fn(),
}));

const mockedExecOnPod = execOnPod as jest.MockedFunction<typeof execOnPod>;

describe('discoverProjectFolder', () => {
  const workspace = {
    name: 'che-demo-app',
    namespace: 'alice-devspaces',
    devworkspaceId: 'workspace123',
    clusterId: 'cluster-1',
    displayName: 'che-demo-app',
    phase: WorkspacePhase.Running,
    started: true,
    gitRepoUrl: 'https://github.com/eclipse-che-demo-app/che-demo-app.git',
  };

  beforeEach(() => {
    mockedExecOnPod.mockReset();
  });

  it('returns VSCODE_DEFAULT_WORKSPACE (.code-workspace) when set on pod container and present on disk', async () => {
    mockedExecOnPod.mockResolvedValue('');
    const kubeConfig = {
      makeApiClient: () => ({
        listNamespacedPod: jest.fn().mockResolvedValue({
          items: [{
            metadata: { name: 'ws-pod-1', labels: { 'controller.devfile.io/devworkspace_name': 'che-demo-app' } },
            spec: {
              containers: [
                { name: 'che-editor-desktop-landing' },
                {
                  name: 'dev-tools',
                  volumeMounts: [{ name: 'projects', mountPath: '/projects' }],
                  env: [{ name: 'VSCODE_DEFAULT_WORKSPACE', value: '/projects/che-demo-app/che-demo.code-workspace' }],
                },
              ],
            },
          }],
        }),
        getNamespacedCustomObject: jest.fn().mockResolvedValue({ spec: { template: { components: [] } } }),
      }),
    };

    const target = await discoverProjectFolder(kubeConfig as any, workspace);
    expect(target).toBe('/projects/che-demo-app/che-demo.code-workspace');
    expect(mockedExecOnPod).toHaveBeenCalledWith(
      kubeConfig,
      'alice-devspaces',
      'ws-pod-1',
      'dev-tools',
      ['test', '-f', '/projects/che-demo-app/che-demo.code-workspace']
    );
  });

  it('falls back to matching git repo directory when VSCODE_DEFAULT_WORKSPACE file is absent', async () => {
    mockedExecOnPod
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('che-demo-app\nche-demo-app-ui\nche-demo-app-service\n');

    const kubeConfig = {
      makeApiClient: () => ({
        listNamespacedPod: jest.fn().mockResolvedValue({
          items: [{
            metadata: { name: 'ws-pod-1' },
            spec: {
              containers: [{
                name: 'dev-tools',
                volumeMounts: [{ name: 'projects', mountPath: '/projects' }],
                env: [{ name: 'VSCODE_DEFAULT_WORKSPACE', value: '/projects/che-demo-app/missing.code-workspace' }],
              }],
            },
          }],
        }),
        getNamespacedCustomObject: jest.fn().mockResolvedValue({ spec: { template: { components: [] } } }),
      }),
    };

    const target = await discoverProjectFolder(kubeConfig as any, workspace);
    expect(target).toBe('/projects/che-demo-app');
  });
});
