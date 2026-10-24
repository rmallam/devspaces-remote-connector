import * as vscode from 'vscode';
import { Logger } from '../util/Logger';
import { ClusterDiscovery } from '../auth/ClusterDiscovery';
import { STATE_CLUSTER_URL, STATE_CLUSTER_DISPLAY_URL } from '../constants';
import { CLUSTERS_STATE_KEY } from '../kubernetes/knownApiUrl';
import { clusterIdFromUrl } from './clusterId';

/**
 * A registered DevSpaces cluster with all resolved endpoints.
 */
export interface ClusterEntry {
  /** Unique ID (derived from hostname) */
  id: string;
  /** The Kubernetes API server URL */
  apiUrl: string;
  /** The DevSpaces dashboard base URL */
  devSpacesUrl: string;
  /** The cluster apps domain (e.g. apps.cluster.example.com) */
  appsDomain: string;
  /** Display name (friendly hostname or devspaces@cluster) */
  displayName: string;
  /** Resolved user namespace (e.g. user-devspaces) */
  namespace?: string;
  /** Authenticated username */
  username?: string;
}

const STORAGE_KEY = CLUSTERS_STATE_KEY;

/**
 * Manages the list of registered DevSpaces clusters.
 *
 * Clusters are stored in globalState. On first launch, clusters from
 * the `devspaces.clusters` setting are pre-populated.
 */
export class ClusterManager {
  private logger = Logger.getInstance();

  constructor(private globalState: vscode.Memento) {}

  /**
   * Ensure clusters from settings are populated on first launch.
   * Call this during activation.
   */
  async ensureDefaults(): Promise<void> {
    // Remove any clusters that aren't valid DevSpaces URLs
    let clusters = this.getClusters();
    const validClusters = clusters.filter((c) => {
      try {
        const hostname = new URL(c.devSpacesUrl).hostname;
        return !hostname.startsWith('git.') && !hostname.startsWith('github.');
      } catch {
        return false;
      }
    });
    if (validClusters.length !== clusters.length) {
      await this.globalState.update(STORAGE_KEY, validClusters);
      this.logger.info(`Cleaned up ${clusters.length - validClusters.length} invalid cluster(s)`);
    }

    // Add clusters from settings if none exist in state
    clusters = this.getClusters();
    if (clusters.length === 0) {
      const configuredClusters = vscode.workspace
        .getConfiguration('devspaces')
        .get<string[]>('clusters', []);
      for (const url of configuredClusters) {
        if (url && url.trim()) {
          await this.addCluster(url.trim());
        }
      }
      clusters = this.getClusters();
      if (clusters.length > 0) {
        await this.globalState.update(STATE_CLUSTER_URL, clusters[0].devSpacesUrl);
        await this.globalState.update(STATE_CLUSTER_DISPLAY_URL, clusters[0].devSpacesUrl);
        this.logger.debug(`Clusters loaded from settings: ${clusters.map(c => c.displayName).join(', ')}`);
      }
    }

    // Fix stale legacy clusterUrl
    const storedUrl = this.globalState.get<string>(STATE_CLUSTER_URL);
    const allClusters = this.getClusters();
    if (allClusters.length > 0) {
      if (!storedUrl || !allClusters.some((c) => c.devSpacesUrl === storedUrl)) {
        await this.globalState.update(STATE_CLUSTER_URL, allClusters[0].devSpacesUrl);
        this.logger.info(`Set clusterUrl to ${allClusters[0].devSpacesUrl}`);
      }
    }
  }

  /**
   * Get all registered clusters.
   */
  getClusters(): ClusterEntry[] {
    return this.globalState.get<ClusterEntry[]>(STORAGE_KEY, []);
  }

  async addCluster(url: string, endpoints?: { apiUrl: string; devSpacesUrl: string; appsDomain: string }): Promise<ClusterEntry> {
    const normalizedUrl = this.normalizeUrl(url);

    // Derive proper devSpacesUrl from any URL format
    let devSpacesUrl = endpoints?.devSpacesUrl ?? normalizedUrl;
    let appsDomain = endpoints?.appsDomain ?? '';
    if (!endpoints) {
      const discovery = new ClusterDiscovery();
      const extracted = discovery.extractAppsDomain(normalizedUrl);
      if (extracted) {
        appsDomain = extracted;
        devSpacesUrl = discovery.buildDevSpacesUrl(normalizedUrl);
      }
    }

    const id = this.urlToId(devSpacesUrl);
    const displayName = this.computeDisplayName(devSpacesUrl);

    const clusters = this.getClusters();
    const existing = clusters.find((c) => c.id === id);
    if (existing) {
      this.logger.info(`Cluster already registered: ${existing.displayName}`);
      return existing;
    }

    const entry: ClusterEntry = {
      id,
      apiUrl: endpoints?.apiUrl ?? '',
      devSpacesUrl,
      appsDomain,
      displayName,
    };
    clusters.push(entry);
    await this.globalState.update(STORAGE_KEY, clusters);

    // Persist to user settings so the cluster survives extension reinstalls
    const config = vscode.workspace.getConfiguration('devspaces');
    const settingsClusters = config.get<string[]>('clusters', []);
    const settingsUrl = endpoints?.devSpacesUrl ?? normalizedUrl;
    if (!settingsClusters.includes(settingsUrl)) {
      settingsClusters.push(settingsUrl);
      await config.update('clusters', settingsClusters, vscode.ConfigurationTarget.Global);
    }

    this.logger.info(`Cluster added: ${displayName} (${entry.devSpacesUrl})`);
    return entry;
  }

  /**
   * Update a cluster's resolved endpoints (called after discovery/auth).
   */
  async updateCluster(id: string, endpoints: { apiUrl: string; devSpacesUrl: string; appsDomain: string }): Promise<void> {
    const clusters = this.getClusters();
    const entry = clusters.find((c) => c.id === id);
    if (!entry) { return; }
    entry.apiUrl = endpoints.apiUrl;
    entry.devSpacesUrl = endpoints.devSpacesUrl;
    entry.appsDomain = endpoints.appsDomain;
    await this.globalState.update(STORAGE_KEY, clusters);
    this.logger.debug(`Cluster ${id} updated: api=${endpoints.apiUrl}, devspaces=${endpoints.devSpacesUrl}`);
  }

  /**
   * Store the resolved namespace and username for a cluster.
   */
  async updateClusterNamespace(id: string, namespace: string, username: string): Promise<void> {
    const clusters = this.getClusters();
    const entry = clusters.find((c) => c.id === id);
    if (!entry) { return; }
    entry.namespace = namespace;
    entry.username = username;
    await this.globalState.update(STORAGE_KEY, clusters);
    this.logger.debug(`Cluster ${id} namespace: ${namespace}, user: ${username}`);
  }

  async removeCluster(id: string): Promise<void> {
    let clusters = this.getClusters();
    const removed = clusters.find((c) => c.id === id);
    clusters = clusters.filter((c) => c.id !== id);
    await this.globalState.update(STORAGE_KEY, clusters);

    if (removed) {
      const config = vscode.workspace.getConfiguration('devspaces');
      const settingsClusters = config.get<string[]>('clusters', []);
      const filtered = settingsClusters.filter((u) => {
        const normalized = this.normalizeUrl(u);
        return normalized !== removed.devSpacesUrl && normalized !== this.normalizeUrl(removed.devSpacesUrl);
      });
      if (filtered.length !== settingsClusters.length) {
        await config.update('clusters', filtered, vscode.ConfigurationTarget.Global);
      }

      this.logger.info(`Cluster removed: ${removed.displayName}`);
    }
  }

  /**
   * Compute a friendly display name from a URL.
   */
  private computeDisplayName(url: string): string {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      // Short/friendly hostnames — use directly
      if (!hostname.includes('.openshiftapps.com') && !hostname.includes('.p1.')) {
        return hostname;
      }
      // e.g. devspaces.apps.devspc02-1d.zs5b.p1.openshiftapps.com → devspaces@devspc02-1d
      // ROSA keeps the cluster name, not the shared "rosa" label.
      const clusterName = clusterIdFromUrl(url);
      if (!clusterName.includes('.')) {
        return `devspaces@${clusterName}`;
      }
      return hostname;
    } catch {
      return url;
    }
  }

  /**
   * Normalize a URL: add https://, strip paths, fragments, and query params.
   * Returns just the origin (scheme + host + port).
   */
  private normalizeUrl(url: string): string {
    let u = url.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
      u = 'https://' + u;
    }
    try {
      return new URL(u).origin;
    } catch {
      return u.replace(/\/+$/, '');
    }
  }

  /**
   * Generate a stable ID from a URL.
   * Dedicated OpenShift apps domains use the cluster name.
   * ROSA and shared-ingress hosts must not share one id across clusters.
   */
  urlToId(url: string): string {
    return clusterIdFromUrl(url);
  }
}
