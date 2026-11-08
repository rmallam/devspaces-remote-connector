import * as k8s from '@kubernetes/client-node';
import { DevWorkspaceApi } from './DevWorkspaceApi';
import { WorkspacePhase } from '../constants';

describe('DevWorkspaceApi watch stream', () => {
  it('streams ADDED and MODIFIED DevWorkspace events into WorkspaceModel updates', async () => {
    const abort = jest.fn();
    (k8s.Watch as unknown as jest.Mock).mockImplementation(() => ({
      watch: jest.fn(async (_path, _query, onEvent) => {
        onEvent('MODIFIED', {
          metadata: { name: 'empty-13eh', uid: 'dw-1' },
          spec: { started: true },
          status: { phase: 'Running', devworkspaceId: 'dw-1' },
        });
        return { abort };
      }),
    }));

    const api = new DevWorkspaceApi({} as any, 'rosa-rwx5g', {} as k8s.KubeConfig);
    const events: Array<{ type: string; phase: string; name: string }> = [];
    const controller = await api.watch(
      'cluster-admin-devspaces',
      (type, ws) => events.push({ type, phase: ws.phase, name: ws.name }),
      () => undefined,
    );

    expect(events).toEqual([
      { type: 'MODIFIED', phase: WorkspacePhase.Running, name: 'empty-13eh' },
    ]);
    controller?.abort();
    expect(abort).toHaveBeenCalled();
  });
});
