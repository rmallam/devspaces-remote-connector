import * as vscode from 'vscode';
import { ClusterManager } from '../cluster/ClusterManager';
import { WorkspaceManager } from '../workspace/WorkspaceManager';
import { WorkspaceTreeProvider } from '../ui/WorkspaceTreeProvider';
import { ClusterTreeItem } from '../ui/WorkspaceTreeItem';
import { TokenManager } from '../auth/TokenManager';
import { OpenShiftAuthProvider } from '../auth/OpenShiftAuthProvider';
import { storedUrlNamesCluster, tokenStorageKeys } from '../kubernetes/knownApiUrl';
import { STATE_CLUSTER_URL, STATE_CLUSTER_DISPLAY_URL, STATE_ACTIVE_CONNECTION, CTX_AUTHENTICATED, CTX_CONNECTED } from '../constants';

export interface ClusterCommandsDeps {
  context: vscode.ExtensionContext;
  clusterManager: ClusterManager;
  tokenManager: TokenManager;
  authProvider: OpenShiftAuthProvider;
  treeProvider: () => WorkspaceTreeProvider | undefined;
  clusterWorkspaceManagers: Map<string, WorkspaceManager>;
  refreshIntervals: Map<string, NodeJS.Timeout>;
  initCluster: (clusterId: string, clusterUrl: string) => Promise<WorkspaceManager | undefined>;
  cleanupConnection: (silent?: boolean) => Promise<void>;
}

export function registerClusterCommands(deps: ClusterCommandsDeps): void {
  const {
    context, clusterManager, tokenManager, authProvider, treeProvider,
    clusterWorkspaceManagers, refreshIntervals,
    initCluster, cleanupConnection,
  } = deps;

  // --- Add Cluster ---
  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.addCluster', async () => {
      const url = await vscode.window.showInputBox({
        prompt: 'Enter any URL from your Dev Spaces cluster',
        placeHolder: 'https://devspaces.example.com or https://devspaces.apps.cluster-name...',
        ignoreFocusOut: true,
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return 'Please enter a URL';
          }
          const toValidate = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
          try {
            new URL(toValidate);
            return undefined;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      });
      if (!url) {
        return;
      }

      const entry = await clusterManager.addCluster(url.trim());

      await context.globalState.update(STATE_CLUSTER_URL, entry.devSpacesUrl);
      await context.globalState.update(STATE_CLUSTER_DISPLAY_URL, entry.devSpacesUrl);

      const tp = treeProvider();
      if (tp) {
        tp.setClusters(clusterManager.getClusters());
      }

      await initCluster(entry.id, entry.devSpacesUrl);

      vscode.window.showInformationMessage(
        `Cluster added: ${entry.displayName}. Sign in to connect.`
      );

      vscode.commands.executeCommand('devspaces.signIn');
    })
  );

  // --- Remove Cluster ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'devspaces.removeCluster',
      async (item?: ClusterTreeItem) => {
        let cluster = item?.cluster;
        if (!cluster) {
          const clusters = clusterManager.getClusters();
          if (clusters.length === 0) { return; }
          if (clusters.length === 1) {
            cluster = clusters[0];
          } else {
            const picked = await vscode.window.showQuickPick(
              clusters.map((c) => ({ label: c.displayName, description: c.devSpacesUrl, cluster: c })),
              { placeHolder: 'Select a cluster to remove', ignoreFocusOut: true }
            );
            if (!picked) { return; }
            cluster = picked.cluster;
          }
        }

        const confirm = await vscode.window.showWarningMessage(
          `Remove cluster "${cluster.displayName}"? This will disconnect any active sessions.`,
          { modal: true },
          'Remove'
        );
        if (confirm !== 'Remove') {
          return;
        }

        await cleanupConnection(true);
        await clusterManager.removeCluster(cluster.id);

        // Clear stored credentials for all aliases of this cluster
        for (const key of tokenStorageKeys(cluster.devSpacesUrl, [cluster])) {
          await tokenManager.deleteToken(key);
        }

        // Clear stored cluster URL if it belongs to the removed cluster
        const storedUrl = context.globalState.get<string>(STATE_CLUSTER_URL);
        if (storedUrlNamesCluster(storedUrl, cluster)) {
          const remaining = clusterManager.getClusters();
          await context.globalState.update(STATE_CLUSTER_URL, remaining[0]?.devSpacesUrl);
          await context.globalState.update(STATE_CLUSTER_DISPLAY_URL, remaining[0]?.devSpacesUrl);
        }

        const removedWm = clusterWorkspaceManagers.get(cluster.id);
        if (removedWm) {
          removedWm.dispose();
          clusterWorkspaceManagers.delete(cluster.id);
        }
        const removedInterval = refreshIntervals.get(cluster.id);
        if (removedInterval) {
          clearInterval(removedInterval);
          refreshIntervals.delete(cluster.id);
        }

        const tp = treeProvider();

        // If no clusters remain, do a full auth reset (same as clearAuth)
        if (clusterManager.getClusters().length === 0) {
          const sessions = await authProvider.getSessions();
          for (const session of sessions) {
            await authProvider.removeSession(session.id);
          }
          await context.globalState.update(STATE_ACTIVE_CONNECTION, undefined);
          if (tp) { tp.setClusters([]); }
          await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, false);
          await vscode.commands.executeCommand('setContext', CTX_CONNECTED, false);
        } else {
          if (tp) { tp.setClusters(clusterManager.getClusters()); }
        }

        vscode.window.showInformationMessage(
          `Cluster "${cluster.displayName}" removed`
        );
      }
    )
  );

  // --- Sign In to Cluster (re-auth after sign-out) ---
  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.signInCluster', async (item?: ClusterTreeItem) => {
      if (!item?.cluster) { return; }
      try {
        await context.globalState.update(STATE_CLUSTER_URL, item.cluster.devSpacesUrl);
        await context.globalState.update(STATE_CLUSTER_DISPLAY_URL, item.cluster.devSpacesUrl);
        await authProvider.createSession([]);
        await initCluster(item.cluster.id, item.cluster.devSpacesUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('cancelled')) {
          vscode.window.showErrorMessage(`Sign-in failed: ${msg}`);
        }
      }
    })
  );

  // --- Sign Out from Cluster ---
  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.signOutCluster', async (item?: ClusterTreeItem) => {
      let cluster = item?.cluster;
      if (!cluster) {
        const clusters = clusterManager.getClusters();
        if (clusters.length === 0) { return; }
        if (clusters.length === 1) { cluster = clusters[0]; }
        else {
          const picked = await vscode.window.showQuickPick(
            clusters.map((c) => ({ label: c.displayName, description: c.devSpacesUrl, cluster: c })),
            { placeHolder: 'Select a cluster to sign out from', ignoreFocusOut: true }
          );
          if (!picked) { return; }
          cluster = picked.cluster;
        }
      }

      for (const key of tokenStorageKeys(cluster.devSpacesUrl, [cluster])) {
        await tokenManager.deleteToken(key);
      }

      const wm = clusterWorkspaceManagers.get(cluster.id);
      if (wm) {
        wm.dispose();
        clusterWorkspaceManagers.delete(cluster.id);
      }
      const interval = refreshIntervals.get(cluster.id);
      if (interval) {
        clearInterval(interval);
        refreshIntervals.delete(cluster.id);
      }

      const tp = treeProvider();
      if (tp) { tp.setClusterSignedOut(cluster.id); }

      vscode.window.showInformationMessage(`Signed out from "${cluster.displayName}". Click the cluster to sign in again.`);
    })
  );
}
