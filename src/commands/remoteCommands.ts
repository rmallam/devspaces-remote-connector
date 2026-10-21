import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import * as net from 'net';
import * as jsYaml from 'js-yaml';
import { Logger } from '../util/Logger';
import { TokenManager } from '../auth/TokenManager';
import { ClusterDiscovery } from '../auth/ClusterDiscovery';
import { KubeClientFactory } from '../kubernetes/KubeClientFactory';
import { KubeAuthHelper, findWorkspacePodAndContainer, getDevWorkspacePhase } from '../kubernetes/KubeAuthHelper';
import { DevWorkspaceResource } from '../kubernetes/DevWorkspaceTypes';
import { execOnPod } from '../kubernetes/execHelper';
import { SIDECAR_PREFIXES, DW_API_GROUP, DW_API_VERSION, DW_PLURAL, STATE_ACTIVE_CONNECTION, LABEL_DEVWORKSPACE_ID, MACHINE_EXEC_PORT } from '../constants';
import { CLUSTERS_STATE_KEY, KnownCluster, lookupKnownApiUrl } from '../kubernetes/knownApiUrl';
import { OpenShiftAuthProvider } from '../auth/OpenShiftAuthProvider';
import { ActivityTrackerService } from '../remote/ActivityTrackerService';

export interface ActiveConnectionInfo {
  workspaceName: string;
  namespace: string;
  devworkspaceId: string;
  clusterUrl: string;
  hostAlias?: string;
  sshUsername?: string;
  localPort?: number;
  projectFolder?: string;
}

/**
 * Register commands available in the remote session (connected to a workspace).
 * These use the stored connection info + token to interact with the K8s API.
 */
export function registerRemoteCommands(
  context: vscode.ExtensionContext,
  conn: ActiveConnectionInfo
): void {
  const logger = Logger.getInstance();
  const tokenManager = new TokenManager(context.globalState);
  const clusterDiscovery = new ClusterDiscovery();
  const kubeClientFactory = new KubeClientFactory();
  const authHelper = new KubeAuthHelper(tokenManager, clusterDiscovery, kubeClientFactory);

  async function getKubeConfig(): Promise<k8s.KubeConfig> {
    const knownApi = lookupKnownApiUrl(storedClusters(context.globalState), conn.clusterUrl);
    return authHelper.requireKubeConfig(conn.clusterUrl, [], knownApi);
  }

  function getCustomApi(kc: k8s.KubeConfig): k8s.CustomObjectsApi {
    return kc.makeApiClient(k8s.CustomObjectsApi);
  }

  async function patchWorkspace(customApi: k8s.CustomObjectsApi, body: any[]): Promise<void> {
    await customApi.patchNamespacedCustomObject({
      group: DW_API_GROUP, version: DW_API_VERSION, plural: DW_PLURAL,
      namespace: conn.namespace, name: conn.workspaceName, body,
    });
  }

  async function waitForPhase(
    customApi: k8s.CustomObjectsApi,
    targetPhases: string[],
    failPhases: string[] = ['Failed'],
    timeoutMs = 120_000
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const phase = await getDevWorkspacePhase(customApi, conn.namespace, conn.workspaceName);
      if (targetPhases.includes(phase)) { return phase; }
      if (failPhases.includes(phase)) {
        throw new Error(`Workspace entered ${phase} state`);
      }
    }
    throw new Error(`Timed out waiting for workspace to reach ${targetPhases.join('/')}`);
  }

  // --- Stop Workspace ---
  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.stopWorkspace', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Stop this workspace? The remote session will close.',
        { modal: true }, 'Stop'
      );
      if (confirm !== 'Stop') { return; }
      try {
        const kc = await getKubeConfig();
        await patchWorkspace(getCustomApi(kc), [
          { op: 'replace', path: '/spec/started', value: false },
        ]);
        vscode.window.showInformationMessage('Workspace stopping...');
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to stop workspace: ${err instanceof Error ? err.message : err}`);
      }
    })
  );

  // --- Restart Workspace ---
  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.restartWorkspace', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Restart this workspace? The remote session will reconnect.',
        { modal: true }, 'Restart'
      );
      if (confirm !== 'Restart') { return; }
      try {
        const kc = await getKubeConfig();
        const api = getCustomApi(kc);
        await patchWorkspace(api, [{ op: 'replace', path: '/spec/started', value: false }]);
        await waitForPhase(api, ['Stopped', 'Failed']);
        await patchWorkspace(api, [{ op: 'replace', path: '/spec/started', value: true }]);
        await waitForPhase(api, ['Running']);
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to restart workspace: ${err instanceof Error ? err.message : err}`);
      }
    })
  );

  // --- Restart from Local Devfile ---
  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.restartFromLocalDevfile', async () => {
      try {
        const kc = await getKubeConfig();

        // Find the pod and main container
        const { podName, containerName } = await findWorkspacePodAndContainer(kc, conn.namespace, conn.devworkspaceId);

        // Helper: exec a command on the pod
        const execCmd = (cmd: string) => execOnPod(kc, conn.namespace, podName, containerName, cmd);

        // Scan for devfiles
        const findResult = await execCmd(
          'find /projects -maxdepth 2 \\( -name "devfile.yaml" -o -name ".devfile.yaml" -o -name "devfile.yml" -o -name ".devfile.yml" \\) -type f 2>/dev/null'
        );
        const devfiles = findResult.split('\n').filter((f) => f.trim().length > 0);

        // Build quick pick
        const items: vscode.QuickPickItem[] = devfiles.map((f) => ({
          label: f,
          detail: f.split('/').slice(2, 3).join('/'),
        }));
        items.push({ kind: vscode.QuickPickItemKind.Separator, label: '' });
        items.push({ label: '/projects/*', detail: 'Select a Devfile with a different name' });

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a Devfile to be applied to the current workspace',
        });
        if (!picked) { return; }

        let devfilePath: string;
        if (picked.label === '/projects/*') {
          const typed = await vscode.window.showInputBox({
            prompt: 'Enter the full path to the devfile on the workspace',
            placeHolder: '/projects/my-app/my-devfile.yaml',
            ignoreFocusOut: true,
          });
          if (!typed) { return; }
          devfilePath = typed.trim();
        } else {
          devfilePath = picked.label;
        }

        // Confirm
        const action = await vscode.window.showWarningMessage(
          `Restart workspace from ${devfilePath}? This will update the workspace configuration and restart.`,
          { modal: true }, 'Restart'
        );
        if (action !== 'Restart') { return; }

        // Validate and read devfile from pod
        if (/[\x00-\x1f]/.test(devfilePath)) {
          throw new Error('Invalid devfile path: contains control characters');
        }
        const safePath = devfilePath.replace(/'/g, "'\\''");
        const devfileContent = await execCmd(`cat -- '${safePath}'`);

        // Get current DevWorkspace CR
        const api = getCustomApi(kc);
        const dw = await api.getNamespacedCustomObject({
          group: DW_API_GROUP, version: DW_API_VERSION, namespace: conn.namespace, plural: DW_PLURAL, name: conn.workspaceName,
        }) as DevWorkspaceResource;

        // Parse and merge
        const localDevfile = jsYaml.load(devfileContent) as Record<string, any>;
        const currentTemplate = dw.spec?.template ?? {};
        const updatedTemplate: any = { ...currentTemplate };

        if (localDevfile.components) {
          const editorComponents = (currentTemplate.components ?? []).filter(
            (c: any) => c.container && SIDECAR_PREFIXES.some((p) => c.name.startsWith(p))
          );
          updatedTemplate.components = [...localDevfile.components, ...editorComponents];
        }
        if (localDevfile.commands) {
          updatedTemplate.commands = localDevfile.commands;
        }

        // Patch template and restart — reload immediately, resolver handles the wait
        await patchWorkspace(api, [
          { op: 'replace', path: '/spec/template', value: updatedTemplate },
          { op: 'replace', path: '/spec/started', value: false },
        ]);
        // Start immediately (don't wait for Stopped — avoid status monitor race)
        await patchWorkspace(api, [{ op: 'replace', path: '/spec/started', value: true }]);
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to restart from devfile: ${err instanceof Error ? err.message : err}`
        );
      }
    })
  );

  // --- Open Dashboard ---
  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.openInDashboard', async () => {
      const dashboardUrl = `${conn.clusterUrl}/dashboard/#/workspaces`;
      await vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
    })
  );

  // --- Open OpenShift Console ---
  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.openConsole', async () => {
      const discovery = new ClusterDiscovery();
      const appsDomain = discovery.extractAppsDomain(conn.clusterUrl);
      const consoleUrl = appsDomain
        ? `https://console-openshift-console.${appsDomain}`
        : conn.clusterUrl;
      await vscode.env.openExternal(vscode.Uri.parse(consoleUrl));
    })
  );

  logger.info('Remote commands registered');
}

export async function track(events: vscode.Event<any>[], logger: Logger, context: vscode.ExtensionContext, authProvider: OpenShiftAuthProvider) {
  const activeConn: ActiveConnectionInfo | undefined = context.globalState.get<ActiveConnectionInfo>(STATE_ACTIVE_CONNECTION);
  if (!activeConn) {
    logger.info(`Unable to retrieve active connection info.`);
    return;
  }

  const clusterDiscovery: ClusterDiscovery = new ClusterDiscovery();
  const knownApi = lookupKnownApiUrl(storedClusters(context.globalState), activeConn.clusterUrl);
  const apiUrl = knownApi || (await clusterDiscovery.discover(activeConn.clusterUrl)).apiUrl;
  if (!apiUrl) {
    logger.info(`Unable to retrieve cluster URL for active connection.`);
    return;
  }

  const kubeClientFactory = new KubeClientFactory();
  const kubeConfig: k8s.KubeConfig = kubeClientFactory.createConfig(apiUrl, await authProvider.getAccessToken());
  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
  const podList = await coreApi.listNamespacedPod({
    namespace: activeConn.namespace,
    labelSelector: `${LABEL_DEVWORKSPACE_ID}=${activeConn.devworkspaceId}`,
  });
  if (podList.items.length === 0) {
    logger.info(`Unable to retrieve pod in namespace: ${activeConn.namespace} with devworkspaceId: ${activeConn.devworkspaceId}.`);
    return;
  }

  const pod = podList.items[0];
  const podName = pod.metadata?.name;
  if (!podName) {
    return;
  }

  const forward = new k8s.PortForward(kubeConfig);
  const server = net.createServer((socket) => {
    void forward.portForward(activeConn.namespace, podName, [MACHINE_EXEC_PORT], socket, null, socket);
  });

  const localPort = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });

  const activityTracker = new ActivityTrackerService(logger, localPort);

  events.forEach((e: vscode.Event<any>) => {
    context.subscriptions.push(
      e(async () => {
        await activityTracker.resetTimeout();
      })
    );
  });
}

function storedClusters(globalState: { get<T>(key: string): T | undefined }): KnownCluster[] {
  return globalState.get<KnownCluster[]>(CLUSTERS_STATE_KEY) ?? [];
}
