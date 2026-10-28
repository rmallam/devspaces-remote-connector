import { Logger } from '../util/Logger';
import { request, HttpError } from '../util/httpClient';

export interface ClusterEndpoints {
  /** The DevSpaces dashboard base URL, e.g. https://devspaces.apps.devspc02-1d.zs5b.p1.openshiftapps.com */
  devSpacesUrl: string;
  /** The OpenShift API server URL, e.g. https://api.devspc02-1d.zs5b.p1.openshiftapps.com:6443 */
  apiUrl: string;
  /** The OAuth authorization endpoint */
  oauthAuthorizeUrl: string;
  /** The OAuth token endpoint */
  oauthTokenUrl: string;
  /** The cluster apps domain, e.g. apps.devspc02-1d.zs5b.p1.openshiftapps.com */
  appsDomain: string;
}

/**
 * Discovers OpenShift cluster endpoints from any URL the user provides.
 *
 * Handles all these URL patterns:
 * - https://devspaces.apps.devspc02-1d.zs5b.p1.openshiftapps.com/
 * - https://devspaces.apps.devspc02-1d.zs5b.p1.openshiftapps.com/dashboard/#/workspaces
 * - https://devspaces.apps.devspc02-1d.zs5b.p1.openshiftapps.com/284992/flights-mgmt/3100/
 * - https://console-openshift-console.apps.devspc02-1d.zs5b.p1.openshiftapps.com/
 * - https://devspaces.example.com (CNAME alias)
 * - https://api.devspc02-1d.zs5b.p1.openshiftapps.com:6443
 */
/** Probes against a guessed console/API host must not spin the sign-in UI. */
const DISCOVERY_TIMEOUT_MS = 5_000;

export class ClusterDiscovery {
  private logger = Logger.getInstance();

  /**
   * Extract the apps domain from any URL the user pastes.
   *
   * The apps domain is the part after the first subdomain:
   *   devspaces.apps.devspc02-1d.xxx → apps.devspc02-1d.xxx
   *   console-openshift-console.apps.devspc02-1d.xxx → apps.devspc02-1d.xxx
   *
   * For API URLs: api.devspc02-1d.xxx → apps.devspc02-1d.xxx
   * For CNAMEs (e.g. devspaces.example.com): we need to follow the /oauth/start redirect.
   */
  extractAppsDomain(inputUrl: string): string | undefined {
    try {
      const url = new URL(inputUrl);
      const host = url.hostname;

      // Pattern 1: api.<cluster-domain> → apps.<cluster-domain>
      if (host.startsWith('api.')) {
        return 'apps.' + host.slice(4);
      }

      // Pattern 2: <something>.apps.<cluster-domain> → apps.<cluster-domain>
      let appsIdx = host.indexOf('.apps.');
      if (appsIdx === -1) {
        appsIdx = host.indexOf('.apps-');
      }
      if (appsIdx !== -1) {
        return host.slice(appsIdx + 1); // strip the leading subdomain
      }

      // Pattern 3: apps.<cluster-domain> directly
      if (host.startsWith('apps.')) {
        return host;
      }

      // Can't determine from hostname alone (e.g. CNAME alias)
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Normalize any user-provided URL into a clean DevSpaces base URL.
   * Strips paths, fragments, query params.
   */
  normalizeInputUrl(inputUrl: string): string {
    let url = inputUrl.trim();

    // Add https:// if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    try {
      const parsed = new URL(url);
      // Return just the origin (scheme + host + port)
      return parsed.origin;
    } catch {
      return url.replace(/\/+$/, '');
    }
  }

  /**
   * Provisional dashboard URL from whatever the user typed.
   *
   * A dashboard, console, or CNAME host is kept as-is so a shared ingress is
   * not rewritten. An API server host is not a dashboard: the provisional
   * value is `https://devspaces.<apps-domain>`, and ClusterSessionManager
   * replaces it with the CheCluster route after login.
   */
  buildDevSpacesUrl(baseUrl: string): string {
    const normalized = this.normalizeInputUrl(baseUrl);
    let hostname: string;
    try {
      hostname = new URL(normalized).hostname;
    } catch {
      return normalized;
    }
    if (!hostname.startsWith('api.')) {
      return normalized;
    }

    const clusterDomain = hostname.slice('api.'.length);
    // ROSA publishes routes on apps.rosa.<cluster>, not apps.<cluster>.
    // A cluster name that merely begins with "rosa-" still needs that label.
    const appsDomain = clusterDomain.endsWith('.openshiftapps.com') && !clusterDomain.startsWith('rosa.')
      ? `apps.rosa.${clusterDomain}`
      : `apps.${clusterDomain}`;
    return `https://devspaces.${appsDomain}`;
  }

  /**
   * Keep an API server URL the user pasted. Guessing the API from the apps
   * domain drops the port and, on ROSA, the `apps.rosa` label.
   */
  resolveApiUrl(inputUrl: string, discoveredApiUrl: string): string {
    const normalized = this.normalizeInputUrl(inputUrl);
    try {
      if (new URL(normalized).hostname.startsWith('api.')) {
        return normalized;
      }
    } catch {
      // Fall through to the discovered API server.
    }
    return discoveredApiUrl;
  }

  /**
   * Discover cluster endpoints from any URL the user provides.
   *
   * An API server URL is used as-is. A Dev Spaces / shared-ingress URL is not
   * a Kubernetes server: guessing `api.` or `console-openshift-console.` from
   * that host hangs. Follow `/oauth/start` to the real `oauth-openshift` apps
   * domain, or ask for the API URL.
   */
  async discover(inputUrl: string): Promise<ClusterEndpoints> {
    this.logger.info(`Discovering cluster endpoints from: ${inputUrl}`);

    const baseUrl = this.normalizeInputUrl(inputUrl);
    const pastedApi = this.resolveApiUrl(baseUrl, '');
    const appsDomain = pastedApi
      ? (this.extractAppsDomain(baseUrl) ?? '')
      : await this.resolveAppsDomainFromDashboard(baseUrl);

    let apiUrl: string;
    if (pastedApi) {
      apiUrl = pastedApi;
    } else {
      apiUrl = await this.buildKubeAPIServerURL(appsDomain);
    }
    const devSpacesUrl = this.buildDevSpacesUrl(baseUrl);

    this.logger.debug(`Apps domain: ${appsDomain}`);
    this.logger.debug(`API URL: ${apiUrl}`);
    this.logger.debug(`DevSpaces URL: ${devSpacesUrl}`);

    const oauthMeta = await this.fetchOAuthMetadata(baseUrl, apiUrl);

    const endpoints: ClusterEndpoints = {
      devSpacesUrl,
      apiUrl,
      oauthAuthorizeUrl: oauthMeta.authorization_endpoint,
      oauthTokenUrl: oauthMeta.token_endpoint,
      appsDomain,
    };

    this.logger.info(`Cluster discovery complete: API=${apiUrl}, DevSpaces=${devSpacesUrl}`);
    return endpoints;
  }

  async buildKubeAPIServerURL(appsDomain: string): Promise<string> {
    const consoleURL = `https://console-openshift-console.${appsDomain}`;
    const clusterBase = appsDomain.replace(/^apps\./, '')
    const defaultApiUrl = `https://api.${clusterBase}:6443`
    try {
      const response = await request({ url: consoleURL, method: 'GET', timeout: DISCOVERY_TIMEOUT_MS })
      const html = response.data

      // Find the line with window.SERVER_FLAGS = {...};
      // https://github.com/openshift/console/blob/release-4.21/frontend/public/index.html#L62
      // https://github.com/openshift/console/blob/release-4.21/pkg/server/server.go#L805-L811
      // https://github.com/openshift/console/blob/release-4.21/pkg/server/server.go#L124
      const match = html.match(/window\.SERVER_FLAGS\s*=\s*({[\s\S]*?});/)

      if (!match || !match[1]) {
        this.logger.debug(`Could not find SERVER_FLAGS in ${consoleURL} HTML response`)
        this.logger.debug(`Falling back to ${defaultApiUrl}`)
        return defaultApiUrl
      }

      const serverFlags = JSON.parse(match[1])
      return serverFlags.kubeAPIServerURL
    } catch (err) {
      this.logger.debug(`Failed to derive the Kubernetes API Server URL : ${err}`)
      this.logger.debug(`Falling back to ${defaultApiUrl}`);
      return defaultApiUrl;
    }
  }

  /**
   * Find the real OpenShift apps domain from a dashboard / shared-ingress URL.
   *
   * The dashboard hostname is not the cluster apps domain on a shared ingress.
   * Guessing `console-openshift-console.` or `api.` from it hangs. Prefer the
   * `/oauth/start` hop to `oauth-openshift.apps.<cluster>`.
   */
  private async resolveAppsDomainFromDashboard(baseUrl: string): Promise<string> {
    const fromRedirect = await this.tryAppsDomainFromOAuthStart(baseUrl);
    if (fromRedirect) {
      this.logger.debug(`Apps domain from /oauth/start: ${fromRedirect}`);
      return fromRedirect;
    }
    const extracted = this.extractAppsDomain(baseUrl);
    if (extracted && this.isManagedOpenShiftAppsDomain(extracted)) {
      return extracted;
    }
    throw new Error(
      `Could not find the OpenShift API from ${baseUrl}. ` +
      `A Dev Spaces URL on a shared ingress is not the API server. ` +
      `Paste the API server URL instead (https://api.<cluster>:6443).`
    );
  }

  private isManagedOpenShiftAppsDomain(appsDomain: string): boolean {
    return /\.openshiftapps\.com$/.test(appsDomain);
  }

  private async tryAppsDomainFromOAuthStart(baseUrl: string): Promise<string | undefined> {
    const url = `${baseUrl}/oauth/start`;
    this.logger.debug(`Following redirect from ${url}`);
    try {
      await request({
        url,
        method: 'GET',
        headers: { Accept: 'text/html' },
        timeout: DISCOVERY_TIMEOUT_MS,
      });
      return undefined;
    } catch (err) {
      if (err instanceof HttpError && err.statusCode >= 300 && err.statusCode < 400) {
        const location = err.responseHeaders.location;
        if (location) {
          const locationStr = Array.isArray(location) ? location[0] : location;
          const appsDomain = this.appsDomainFromOAuthLocation(locationStr);
          if (appsDomain) {
            return appsDomain;
          }
        }
      }
      this.logger.debug(`/oauth/start from ${baseUrl} did not reveal the apps domain: ${err}`);
      return undefined;
    }
  }

  private appsDomainFromOAuthLocation(location: string): string | undefined {
    try {
      const host = new URL(location).hostname.toLowerCase();
      if (!host.startsWith('oauth-openshift.')) {
        return undefined;
      }
      const appsDomain = host.slice('oauth-openshift.'.length);
      if (appsDomain.startsWith('apps.') || appsDomain.startsWith('apps-')) {
        return appsDomain;
      }
    } catch {
      // Ignore a non-URL Location.
    }
    return undefined;
  }

  /**
   * Fetch the OAuth metadata from the OpenShift API server.
   */
  private async fetchOAuthMetadata(
    baseUrl: string,
    apiUrl: string
  ): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
    // Try API server first
    try {
      const url = `${apiUrl}/.well-known/oauth-authorization-server`;
      this.logger.debug(`Fetching OAuth metadata from ${url}`);
      const res = await request({ url, method: 'GET', timeout: DISCOVERY_TIMEOUT_MS });
      const meta = JSON.parse(res.data);
      if (meta.authorization_endpoint && meta.token_endpoint) {
        return meta;
      }
    } catch (apiErr) {
      this.logger.debug(`Failed to fetch OAuth metadata from ${apiUrl}: ${apiErr}`);
    }

    // Fallback: follow /oauth/start redirect to find OAuth server
    try {
      const url = `${baseUrl}/oauth/start`;
      this.logger.debug(`Following redirect from ${url} to discover OAuth endpoints`);
      await request({ url, method: 'GET', headers: { Accept: 'text/html' }, timeout: DISCOVERY_TIMEOUT_MS });
      // If we got a 2xx, there's no redirect
      throw new Error(`Could not discover OAuth endpoints from ${baseUrl}: no redirect from /oauth/start`);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode >= 300 && err.statusCode < 400) {
        const location = err.responseHeaders.location;
        if (location) {
          const locationStr = Array.isArray(location) ? location[0] : location;
          try {
            const oauthServerUrl = new URL(locationStr).origin;
            this.logger.debug(`Discovered OAuth server from redirect: ${oauthServerUrl}`);
            return {
              authorization_endpoint: `${oauthServerUrl}/oauth/authorize`,
              token_endpoint: `${oauthServerUrl}/oauth/token`
            };
          } catch { /* fall through */ }
        }
      }
      throw err instanceof Error
        ? new Error(`Failed to discover OAuth endpoints: ${err.message}`)
        : new Error(`Failed to discover OAuth endpoints`);
    }
  }
}
