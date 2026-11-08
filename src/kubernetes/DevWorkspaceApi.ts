import * as k8s from '@kubernetes/client-node';
import { Logger } from '../util/Logger';
import { DW_API_GROUP, DW_API_VERSION, DW_PLURAL, LABEL_METADATA_NAME, WorkspacePhase } from '../constants';
import { WorkspaceModel } from '../workspace/WorkspaceModel';

/**
 * Wraps the Kubernetes CustomObjectsApi for DevWorkspace CRD operations.
 * Handles listing, getting, starting, stopping, and deleting workspaces.
 *
 * Workspace *creation* is handled by the DevSpaces dashboard (browser flow),
 * not by this class. See the `devspaces.createWorkspace` command in extension.ts.
 */
export class DevWorkspaceApi {
  private logger = Logger.getInstance();

  /** Validate a K8s resource name (RFC 1123 DNS subdomain). */
  private validateName(name: string): void {
    if (!/^[a-z0-9]([a-z0-9\-]{0,251}[a-z0-9])?$/.test(name)) {
      throw new Error(`Invalid resource name: ${name.slice(0, 60)}`);
    }
  }

  /** Validate a K8s namespace name. */
  private validateNamespace(ns: string): void {
    if (!/^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?$/.test(ns)) {
      throw new Error(`Invalid namespace: ${ns.slice(0, 60)}`);
    }
  }

  constructor(
    private customApi: k8s.CustomObjectsApi,
    private clusterId: string,
    private kubeConfig?: k8s.KubeConfig,
  ) {}

  async watch(
    namespace: string,
    onEvent: (type: string, workspace: WorkspaceModel) => void,
    onError: (err: unknown) => void,
  ): Promise<{ abort: () => void } | undefined> {
    this.validateNamespace(namespace);
    if (!this.kubeConfig || typeof k8s.Watch !== 'function') {
      return undefined;
    }
    try {
      const watcher = new k8s.Watch(this.kubeConfig);
      const path = `/apis/${DW_API_GROUP}/${DW_API_VERSION}/namespaces/${namespace}/${DW_PLURAL}`;
      const req = await watcher.watch(
        path,
        {},
        (type: string, apiObj: DevWorkspaceResource) => {
          if (apiObj?.metadata?.name) {
            onEvent(type, this.toModel(apiObj, namespace));
          }
        },
        (err: unknown) => {
          onError(err);
        },
      );
      return req;
    } catch (err) {
      onError(err);
      return undefined;
    }
  }

  async list(namespace: string): Promise<WorkspaceModel[]> {
    this.validateNamespace(namespace);
    this.logger.debug(`Listing DevWorkspaces in ${namespace}`);
    const response = await this.customApi.listNamespacedCustomObject({
      group: DW_API_GROUP, version: DW_API_VERSION, namespace, plural: DW_PLURAL,
    }) as { items: DevWorkspaceResource[] };
    return response.items.map((item) => this.toModel(item, namespace));
  }

  async get(namespace: string, name: string): Promise<WorkspaceModel> {
    this.validateNamespace(namespace);
    this.validateName(name);
    const response = await this.customApi.getNamespacedCustomObject({
      group: DW_API_GROUP, version: DW_API_VERSION, namespace, plural: DW_PLURAL, name,
    }) as DevWorkspaceResource;
    return this.toModel(response, namespace);
  }

  async start(namespace: string, name: string): Promise<void> {
    this.validateNamespace(namespace);
    this.validateName(name);
    this.logger.info(`Starting workspace ${name} in ${namespace}`);
    await this.customApi.patchNamespacedCustomObject({
      group: DW_API_GROUP, version: DW_API_VERSION, namespace, plural: DW_PLURAL, name,
      body: [{ op: 'replace', path: '/spec/started', value: true }],
    });
  }

  async stop(namespace: string, name: string): Promise<void> {
    this.validateNamespace(namespace);
    this.validateName(name);
    this.logger.info(`Stopping workspace ${name} in ${namespace}`);
    await this.customApi.patchNamespacedCustomObject({
      group: DW_API_GROUP, version: DW_API_VERSION, namespace, plural: DW_PLURAL, name,
      body: [{ op: 'replace', path: '/spec/started', value: false }],
    });
  }

  async delete(namespace: string, name: string): Promise<void> {
    this.validateNamespace(namespace);
    this.validateName(name);
    this.logger.info(`Deleting workspace ${name} in ${namespace}`);
    await this.customApi.deleteNamespacedCustomObject({
      group: DW_API_GROUP, version: DW_API_VERSION, namespace, plural: DW_PLURAL, name,
    });
  }

  private toModel(resource: DevWorkspaceResource, namespace: string): WorkspaceModel {
    const status = resource.status ?? {};
    const spec = resource.spec ?? {};
    let gitRepoUrl: string | undefined;
    const projects = spec.template?.projects ?? [];
    if (projects.length > 0 && projects[0].git?.remotes?.origin) {
      gitRepoUrl = projects[0].git.remotes.origin;
    }
    return {
      name: resource.metadata?.name ?? 'unknown',
      displayName: resource.metadata?.labels?.[LABEL_METADATA_NAME] ?? resource.metadata?.name ?? 'unknown',
      namespace,
      phase: (status.phase as WorkspacePhase) ?? WorkspacePhase.Stopped,
      devworkspaceId: status.devworkspaceId ?? resource.metadata?.uid ?? '',
      clusterId: this.clusterId,
      mainUrl: status.mainUrl,
      gitRepoUrl,
      creationTimestamp: resource.metadata?.creationTimestamp,
      started: spec.started ?? false,
    };
  }
}

interface DevWorkspaceResource {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
  };
  spec?: {
    started?: boolean;
    routingClass?: string;
    template?: {
      components?: Array<{ name: string; container?: { image?: string; mountSources?: boolean; sourceMapping?: string } }>;
      projects?: Array<{ name: string; git?: { remotes?: { origin: string } } }>;
    };
  };
  status?: {
    phase?: string;
    devworkspaceId?: string;
    mainUrl?: string;
    message?: string;
    conditions?: Array<{ type: string; status: string; message?: string; reason?: string }>;
  };
}
