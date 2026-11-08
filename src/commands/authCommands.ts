import * as vscode from 'vscode';
import { Logger } from '../util/Logger';
import { OpenShiftAuthProvider } from '../auth/OpenShiftAuthProvider';
import { TokenManager } from '../auth/TokenManager';
import { ClusterManager } from '../cluster/ClusterManager';
import { WorkspaceManager } from '../workspace/WorkspaceManager';
import { WorkspaceTreeProvider } from '../ui/WorkspaceTreeProvider';
import { StatusBarManager } from '../ui/StatusBarManager';
import { tokenStorageKeys } from '../kubernetes/knownApiUrl';
import {
  CTX_AUTHENTICATED,
  CTX_CONNECTED,
  STATE_CLUSTER_URL,
  STATE_CLUSTER_DISPLAY_URL,
  STATE_ACTIVE_CONNECTION,
} from '../constants';

const logger = Logger.getInstance();

export interface AuthCommandsDeps {
  context: vscode.ExtensionContext;
  authProvider: OpenShiftAuthProvider;
  tokenManager: TokenManager;
  clusterManager: ClusterManager;
  statusBar: StatusBarManager;
  treeProvider: () => WorkspaceTreeProvider | undefined;
  clusterWorkspaceManagers: Map<string, WorkspaceManager>;
  refreshIntervals: Map<string, NodeJS.Timeout>;
  loadAllClusters: () => Promise<void>;
}

export function registerAuthCommands(deps: AuthCommandsDeps): void {
  const {
    context, authProvider, tokenManager, clusterManager,
    statusBar, treeProvider, clusterWorkspaceManagers,
    refreshIntervals, loadAllClusters,
  } = deps;

  // --- Sign In ---
  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.signIn', async () => {
      try {
        // If no cluster configured, prompt for URL first
        const clusters = clusterManager.getClusters();
        if (clusters.length === 0) {
          const url = await vscode.window.showInputBox({
            prompt: 'Enter your Dev Spaces cluster URL',
            placeHolder: 'https://devspaces.apps.your-cluster.example.com',
            ignoreFocusOut: true,
            validateInput: (value) => {
              const trimmed = value.trim();
              if (!trimmed) { return 'Please enter a URL'; }
              const toValidate = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
              try { new URL(toValidate); return undefined; } catch { return 'Please enter a valid URL'; }
            },
          });
          if (!url) { return; }
          const entry = await clusterManager.addCluster(url.trim());
          await context.globalState.update(STATE_CLUSTER_URL, entry.devSpacesUrl);
        }

        // Trigger sign-in directly (bypasses VS Code consent dialog)
        await authProvider.createSession([]);
        await loadAllClusters();
        vscode.window.showInformationMessage('Signed in to Dev Spaces');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('self signed certificate in certificate chain')) {
          vscode.window.showErrorMessage(`
            Failed to authenticate because a certificate in the chain appears to be self signed.
            Unset 'devspaces.certificateValidation.enabled' setting to bypass.`, 'Open Settings'
          ).then(resp => {
            if (resp === 'Open Settings') {
              vscode.commands.executeCommand('workbench.action.openSettings', 'devspaces.certificateValidation.enabled');
            }
          })
        } else if (!msg.includes('cancelled')) {
          vscode.window.showErrorMessage(`Sign-in failed: ${msg}`);
        }
        logger.error(`Sign-in failed: ${msg}`);
      }
    })
  );

  // --- Clear All Authentication ---
  context.subscriptions.push(
    vscode.commands.registerCommand('devspaces.clearAuth', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all Dev Spaces authentication? This removes all stored tokens, cluster registrations, and cached state. You will need to sign in again.',
        { modal: true },
        'Clear All'
      );
      if (confirm !== 'Clear All') {
        return;
      }

      try {
        // Remove tokens (stored under multiple keys)
        const clusters = clusterManager.getClusters();
        for (const cluster of clusters) {
          for (const key of tokenStorageKeys(cluster.devSpacesUrl, [cluster])) {
            await tokenManager.deleteToken(key);
          }
        }
        const legacyUrl = context.globalState.get<string>(STATE_CLUSTER_URL);
        if (legacyUrl) {
          await tokenManager.deleteToken(legacyUrl);
        }

        // Fire session-removed events
        const sessions = await authProvider.getSessions();
        for (const session of sessions) {
          await authProvider.removeSession(session.id);
        }

        // Clear globalState
        await context.globalState.update(STATE_CLUSTER_URL, undefined);
        await context.globalState.update(STATE_CLUSTER_DISPLAY_URL, undefined);
        await context.globalState.update(STATE_ACTIVE_CONNECTION, undefined);
        await context.globalState.update('devspaces.connectionsMap', undefined);

        // Remove clusters
        for (const cluster of clusters) {
          await clusterManager.removeCluster(cluster.id);
        }

        // Tear down in-memory state
        for (const wm of clusterWorkspaceManagers.values()) {
          wm.dispose();
        }
        clusterWorkspaceManagers.clear();
        for (const interval of refreshIntervals.values()) {
          clearInterval(interval);
        }
        refreshIntervals.clear();

        // Reset UI
        const tp = treeProvider();
        if (tp) {
          tp.setClusters([]);
        }
        await vscode.commands.executeCommand('setContext', CTX_AUTHENTICATED, false);
        await vscode.commands.executeCommand('setContext', CTX_CONNECTED, false);
        statusBar.setDisconnected();

        // Clear the clusters setting
        await vscode.workspace.getConfiguration('devspaces').update('clusters', [], vscode.ConfigurationTarget.Global);

        // Re-add defaults (will be empty since we just cleared the setting)
        await clusterManager.ensureDefaults();
        if (tp) {
          tp.setClusters(clusterManager.getClusters());
        }

        vscode.window.showInformationMessage(
          'All Dev Spaces authentication cleared. Use "Sign In" to start fresh.'
        );
        logger.info('All authentication state cleared by user');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to clear authentication: ${msg}`);
        logger.error(`Clear auth failed: ${msg}`);
      }
    })
  );
}
