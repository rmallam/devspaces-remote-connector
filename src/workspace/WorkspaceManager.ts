import * as vscode from 'vscode';
import { Logger } from '../util/Logger';
import { DevWorkspaceApi } from '../kubernetes/DevWorkspaceApi';
import { NamespaceApi } from '../kubernetes/NamespaceApi';
import { WorkspaceModel } from './WorkspaceModel';
import { WorkspacePhase } from '../constants';

/**
 * High-level workspace lifecycle orchestrator.
 * Coordinates workspace discovery, lifecycle operations, and state management.
 */
export class WorkspaceManager {
  private logger = Logger.getInstance();
  private workspaces: WorkspaceModel[] = [];
  private userNamespace: string | undefined;
  private watchController: { abort: () => void } | undefined;
  private watchReconnectTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  private readonly onDidChangeWorkspacesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeWorkspaces = this.onDidChangeWorkspacesEmitter.event;

  constructor(
    private devWorkspaceApi: DevWorkspaceApi,
    private namespaceApi: NamespaceApi
  ) {}

  async initialize(username: string): Promise<void> {
    this.userNamespace = await this.namespaceApi.findUserNamespace(username);
    if (!this.userNamespace) {
      this.logger.warn(`No namespace found for user ${username}`);
      return;
    }
    await this.refresh();
    void this.startWatch();
  }

  private async startWatch(): Promise<void> {
    if (this.disposed || !this.userNamespace || typeof this.devWorkspaceApi.watch !== 'function') {
      return;
    }
    this.stopWatch();
    this.watchController = await this.devWorkspaceApi.watch(
      this.userNamespace,
      (type, ws) => {
        if (this.disposed) {
          return;
        }
        if (type === 'DELETED') {
          this.workspaces = this.workspaces.filter((item) => item.name !== ws.name);
        } else {
          const idx = this.workspaces.findIndex((item) => item.name === ws.name);
          if (idx >= 0) {
            this.workspaces[idx] = ws;
          } else {
            this.workspaces.push(ws);
          }
        }
        this.onDidChangeWorkspacesEmitter.fire();
      },
      () => {
        if (this.disposed) {
          return;
        }
        this.watchController = undefined;
        if (!this.watchReconnectTimer) {
          this.watchReconnectTimer = setTimeout(() => {
            this.watchReconnectTimer = undefined;
            void this.startWatch();
          }, 5000);
        }
      },
    );
  }

  private stopWatch(): void {
    if (this.watchReconnectTimer) {
      clearTimeout(this.watchReconnectTimer);
      this.watchReconnectTimer = undefined;
    }
    if (this.watchController) {
      try {
        this.watchController.abort();
      } catch {
        // ignore abort errors
      }
      this.watchController = undefined;
    }
  }

  async refresh(): Promise<void> {
    if (!this.userNamespace) {
      return;
    }
    try {
      this.workspaces = await this.devWorkspaceApi.list(this.userNamespace);
      this.logger.debug(`Loaded ${this.workspaces.length} workspaces`);
      this.onDidChangeWorkspacesEmitter.fire();
    } catch (err) {
      this.logger.error(`Failed to refresh workspaces: ${err}`);
      throw err;
    }
  }

  getWorkspaces(): WorkspaceModel[] {
    return [...this.workspaces];
  }

  getNamespace(): string | undefined {
    return this.userNamespace;
  }

  async startWorkspace(
    name: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<WorkspaceModel> {
    if (!this.userNamespace) {
      throw new Error('User namespace not initialized');
    }
    progress?.report({ message: 'Starting workspace...' });
    await this.devWorkspaceApi.start(this.userNamespace, name);
    return this.waitForPhase(name, WorkspacePhase.Running, progress);
  }

  async stopWorkspace(name: string): Promise<void> {
    if (!this.userNamespace) {
      throw new Error('User namespace not initialized');
    }
    await this.devWorkspaceApi.stop(this.userNamespace, name);
    await this.refresh();
  }

  async deleteWorkspace(name: string): Promise<void> {
    if (!this.userNamespace) {
      throw new Error('User namespace not initialized');
    }
    await this.devWorkspaceApi.delete(this.userNamespace, name);
    await this.refresh();
  }

  private async waitForPhase(
    name: string,
    targetPhase: WorkspacePhase,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<WorkspaceModel> {
    const timeout = vscode.workspace
      .getConfiguration('devspaces')
      .get<number>('connectionTimeout', 300);
    const deadline = Date.now() + timeout * 1000;
    const pollInterval = 3000;

    while (Date.now() < deadline) {
      const ws = await this.devWorkspaceApi.get(this.userNamespace!, name);

      progress?.report({
        message: `Workspace is ${ws.phase.toLowerCase()}...`,
      });

      if (ws.phase === targetPhase) {
        await this.refresh();
        return ws;
      }

      if (ws.phase === WorkspacePhase.Failed) {
        throw new Error(`Workspace ${name} failed to start`);
      }

      // Update cached workspace so tree shows spinner during transitions
      const idx = this.workspaces.findIndex((w) => w.name === name);
      if (idx >= 0) {
        this.workspaces[idx] = ws;
        this.onDidChangeWorkspacesEmitter.fire();
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(
      `Workspace ${name} did not reach ${targetPhase} within ${timeout}s`
    );
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatch();
    this.onDidChangeWorkspacesEmitter.dispose();
  }
}
