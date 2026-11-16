import * as k8s from '@kubernetes/client-node';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../util/Logger';
import { shouldSyncKiroIDECredentials } from '../util/IDEDetector';
import { WorkspaceModel } from '../workspace/WorkspaceModel';
import { PROJECTS_ROOT, SIDECAR_PREFIXES, LABEL_DEVWORKSPACE_ID, DW_API_GROUP, DW_API_VERSION, DW_PLURAL } from '../constants';
import { DevWorkspaceResource } from '../kubernetes/DevWorkspaceTypes';
import { execOnPod } from '../kubernetes/execHelper';

// ─── Kiro Auth Sync ──────────────────────────────────────────────────────────

/**
 * Copy Kiro IDE authentication credentials to the workspace pod.
 *
 * Syncs the AWS SSO cache token and client registration file so that
 * Kiro agent features work inside the remote workspace.
 */
export async function copyKiroAuthToPod(
  kubeConfig: k8s.KubeConfig,
  workspace: WorkspaceModel
): Promise<void> {
  const logger = Logger.getInstance();

  if (!shouldSyncKiroIDECredentials()) {
    logger.debug('Kiro IDE credential sync disabled, skipping');
    return;
  }

  const ssoDir = path.join(os.homedir(), '.aws', 'sso', 'cache');
  const kiroAuthFile = path.join(ssoDir, 'kiro-auth-token.json');
  if (!fs.existsSync(kiroAuthFile)) { return; }

  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
  const podList = await coreApi.listNamespacedPod({
    namespace: workspace.namespace,
    labelSelector: `${LABEL_DEVWORKSPACE_ID}=${workspace.devworkspaceId}`,
  });
  if (podList.items.length === 0) { return; }

  const pod = podList.items[0];
  const podName = pod.metadata?.name ?? '';
  const containers = pod.spec?.containers ?? [];
  const mainContainer = containers.find((c) => !SIDECAR_PREFIXES.some((p) => c.name.startsWith(p))) ?? containers[0];
  const containerName = mainContainer?.name ?? 'tools';

  try {
    const check = await execOnPod(kubeConfig, workspace.namespace, podName, containerName,
      'test -f $HOME/.aws/sso/cache/kiro-auth-token.json && echo EXISTS || echo MISSING');
    if (check === 'EXISTS') { logger.info('Remote already has Kiro IDE auth token, skipping'); return; }

    const authContent = fs.readFileSync(kiroAuthFile, 'utf-8');
    const b64 = Buffer.from(authContent).toString('base64');
    await execOnPod(kubeConfig, workspace.namespace, podName, containerName,
      `mkdir -p $HOME/.aws/sso/cache && printf '%s' '${b64}' | base64 -d > $HOME/.aws/sso/cache/kiro-auth-token.json && chmod 600 $HOME/.aws/sso/cache/kiro-auth-token.json`);
    logger.info('Kiro IDE auth token synced to pod');

    // Sync the client registration file needed for token refresh
    try {
      const tokenData = JSON.parse(authContent);
      const clientIdHash = tokenData.clientIdHash;
      if (clientIdHash) {
        const registrationFile = path.join(ssoDir, `${clientIdHash}.json`);
        if (fs.existsSync(registrationFile)) {
          const regContent = fs.readFileSync(registrationFile, 'utf-8');
          const regB64 = Buffer.from(regContent).toString('base64');
          await execOnPod(kubeConfig, workspace.namespace, podName, containerName,
            `printf '%s' '${regB64}' | base64 -d > $HOME/.aws/sso/cache/${clientIdHash}.json && chmod 600 $HOME/.aws/sso/cache/${clientIdHash}.json`);
          logger.info(`Kiro IDE client registration synced to pod (${clientIdHash.slice(0, 12)}...)`);
        } else {
          logger.debug(`Client registration file not found locally: ${registrationFile}`);
        }
      }
    } catch (regErr) {
      logger.debug(`Could not sync client registration: ${regErr}`);
    }
  } catch (err) {
    logger.debug(`Could not sync Kiro IDE auth: ${err}`);
  }
}

// ─── Project Folder Discovery ────────────────────────────────────────────────

const SAFE_WORKSPACE_FILE_RE = /^\/[a-zA-Z0-9._/-]+\.code-workspace$/;

/**
 * Discover the project folder or `.code-workspace` file inside a workspace pod.
 *
 * Strategy:
 * 1. Read the DevWorkspace CR and live Pod spec to find the main container,
 *    `sourceMapping`, and optional `VSCODE_DEFAULT_WORKSPACE` env var
 * 2. If `VSCODE_DEFAULT_WORKSPACE` points to an existing `.code-workspace` file
 *    on the pod, return it so VS Code opens the multi-root workspace directly
 * 3. Check if the `sourceMapping` directory exists
 * 4. If it has exactly one subdirectory, use that
 * 5. If the workspace has a git repo URL, match by repo name
 * 6. Fall back to the `sourceMapping` root or `$HOME`
 */
export async function discoverProjectFolder(
  kubeConfig: k8s.KubeConfig,
  workspace: WorkspaceModel
): Promise<string> {
  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
  const podList = await coreApi.listNamespacedPod({
    namespace: workspace.namespace,
    labelSelector: `${LABEL_DEVWORKSPACE_ID}=${workspace.devworkspaceId}`,
  });
  const pod = podList.items[0];
  if (!pod) { return PROJECTS_ROOT; }

  const customApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);
  const dwName = pod.metadata?.labels?.['controller.devfile.io/devworkspace_name'] ?? workspace.name;
  let configuredContainerName: string | undefined;
  let sourceMapping = PROJECTS_ROOT;
  let defaultWorkspaceEnv: string | undefined;

  try {
    const dw = await customApi.getNamespacedCustomObject({
      group: DW_API_GROUP, version: DW_API_VERSION, namespace: workspace.namespace, plural: DW_PLURAL, name: dwName,
    }) as DevWorkspaceResource;
    for (const comp of dw?.spec?.template?.components ?? []) {
      if (comp.container && comp.container.mountSources !== false) {
        configuredContainerName = comp.name;
        if (comp.container.sourceMapping) { sourceMapping = comp.container.sourceMapping; }
        const envHit = (comp.container as any).env?.find((e: any) => e?.name === 'VSCODE_DEFAULT_WORKSPACE');
        if (typeof envHit?.value === 'string') {
          defaultWorkspaceEnv = envHit.value.trim();
        }
        break;
      }
    }
  } catch { /* use defaults */ }

  const podContainers = pod.spec?.containers ?? [];
  const nonSidecars = podContainers.filter((c) => !SIDECAR_PREFIXES.some((p) => c.name.startsWith(p)));
  const resolvedContainer =
    (configuredContainerName ? podContainers.find((c) => c.name === configuredContainerName) : undefined)
    ?? nonSidecars.find((c) => c.volumeMounts?.some((vm) => vm.mountPath === PROJECTS_ROOT))
    ?? nonSidecars[0]
    ?? podContainers[0];
  const mainContainerName = resolvedContainer?.name ?? configuredContainerName ?? 'tools';

  if (!defaultWorkspaceEnv && resolvedContainer?.env) {
    const podEnvHit = resolvedContainer.env.find((e) => e.name === 'VSCODE_DEFAULT_WORKSPACE');
    if (podEnvHit?.value) {
      defaultWorkspaceEnv = podEnvHit.value.trim();
    }
  }

  if (
    defaultWorkspaceEnv &&
    SAFE_WORKSPACE_FILE_RE.test(defaultWorkspaceEnv) &&
    !defaultWorkspaceEnv.includes('..')
  ) {
    try {
      await execOnPod(kubeConfig, workspace.namespace, pod.metadata!.name!, mainContainerName, ['test', '-f', defaultWorkspaceEnv]);
      Logger.getInstance().info(`Using VSCODE_DEFAULT_WORKSPACE: ${defaultWorkspaceEnv}`);
      return defaultWorkspaceEnv;
    } catch {
      Logger.getInstance().debug(`VSCODE_DEFAULT_WORKSPACE file not found on pod: ${defaultWorkspaceEnv}`);
    }
  }

  let projectFolder = sourceMapping;

  // Verify sourceMapping exists on the pod
  try {
    await execOnPod(kubeConfig, workspace.namespace, pod.metadata!.name!, mainContainerName, ['test', '-d', sourceMapping]);
  } catch {
    // sourceMapping doesn't exist, fall back to $HOME
    try {
      projectFolder = (await execOnPod(kubeConfig, workspace.namespace, pod.metadata!.name!, mainContainerName, ['bash', '-c', 'echo $HOME'])) || '/home/user';
    } catch {
      projectFolder = '/home/user';
    }
    return projectFolder;
  }

  // List contents and try to pick the right subfolder
  const lsOutput = await execOnPod(kubeConfig, workspace.namespace, pod.metadata!.name!, mainContainerName, ['ls', sourceMapping]);
  const dirs = lsOutput.split('\n').filter((d) => d.trim().length > 0);

  if (dirs.length === 1) {
    return `${sourceMapping}/${dirs[0]}`;
  }

  if (workspace.gitRepoUrl) {
    const repoName = workspace.gitRepoUrl.replace(/\.git$/, '').split('/').pop();
    const match = dirs.find((d) => d === repoName);
    if (match) { return `${sourceMapping}/${match}`; }
  }

  return projectFolder;
}
