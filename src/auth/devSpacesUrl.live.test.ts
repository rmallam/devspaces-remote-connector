/**
 * Checks URL selection against the cluster `oc` is logged into.
 *
 * Skipped unless DEVSPACES_LIVE=1. Does not print tokens and does not change
 * the cluster. The dashboard route on this cluster sits behind an OpenShift
 * login page, so a kubeconfig token is not a dashboard session. The check is
 * that the connector selects the live route, and that the host guessed by
 * stripping `api.` does not exist.
 */
import { execFileSync } from 'child_process';
import { lookup } from 'dns/promises';
import { ClusterDiscovery } from './ClusterDiscovery';
import { chooseDevSpacesUrl, readDevSpacesUrlSources, CustomObjectReader } from './devSpacesUrl';
import { lookupKnownApiUrl } from '../kubernetes/knownApiUrl';

const live = process.env.DEVSPACES_LIVE === '1';
const describeLive = live ? describe : describe.skip;

describeLive('live Dev Spaces URL', () => {
  jest.setTimeout(60_000);

  it('uses the CheCluster route instead of the host guessed from the API name', async () => {
    execFileSync('oc', ['whoami'], { stdio: 'ignore' });

    const apiServer = execFileSync('oc', ['whoami', '--show-server'], { encoding: 'utf8' }).trim();
    const routeHost = execFileSync(
      'oc',
      ['get', 'route', 'devspaces', '-n', 'openshift-devspaces', '-o', 'jsonpath={.spec.host}'],
      { encoding: 'utf8' },
    ).trim();
    const dashboard = `https://${routeHost}`;
    const apiHost = new URL(apiServer).hostname;
    const guessedFromApi = `https://devspaces.apps.${apiHost.slice('api.'.length)}`;

    const sources = await readDevSpacesUrlSources(ocReader());
    const chosen = chooseDevSpacesUrl(sources, guessedFromApi);

    expect(chosen).toEqual({ url: dashboard, source: 'che-cluster' });
    expect(chosen.url).not.toBe(guessedFromApi);
    expect(new ClusterDiscovery().buildDevSpacesUrl(apiServer)).toBe(dashboard);

    await expect(lookup(new URL(guessedFromApi).hostname)).rejects.toThrow();

    const dashboardPage = await fetch(dashboard, { redirect: 'manual' });
    const page = await dashboardPage.text();
    expect([200, 302, 403]).toContain(dashboardPage.status);
    expect(page.includes('/dashboard/') || page.includes('Log In')).toBe(true);

    const apiPath = await fetch(`${apiServer}/api/kubernetes/namespace`);
    const apiBody = await apiPath.text();
    // The API server does not serve the Dev Spaces dashboard. Unauthenticated
    // calls are rejected; an authenticated call 404s because the path is not a
    // Kubernetes API.
    expect([403, 404]).toContain(apiPath.status);
    expect(apiBody.includes('/dashboard/')).toBe(false);

    // A reconnect passes the dashboard host. The API saved at sign-in is the
    // server `oc` is using, not a host derived from that dashboard.
    expect(lookupKnownApiUrl(
      [{ id: 'lab', apiUrl: apiServer, devSpacesUrl: dashboard, appsDomain: 'apps.example.com' }],
      dashboard,
      ['lab'],
    )).toBe(apiServer);
  });
});

function ocReader(): CustomObjectReader {
  return {
    listClusterCustomObject: (request) => ocRaw(
      `/apis/${request.group}/${request.version}/${request.plural}`,
    ),
    listNamespacedCustomObject: (request) => ocRaw(
      `/apis/${request.group}/${request.version}/namespaces/${request.namespace}/${request.plural}`,
    ),
  };
}

function ocRaw(path: string): Promise<unknown> {
  const body = execFileSync('oc', ['get', '--raw', path], { encoding: 'utf8' });
  return Promise.resolve(JSON.parse(body) as unknown);
}
