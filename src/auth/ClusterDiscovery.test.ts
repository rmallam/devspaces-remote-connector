import { ClusterDiscovery } from './ClusterDiscovery';
import { request, HttpError } from '../util/httpClient';

jest.mock('../util/httpClient', () => {
  const actual = jest.requireActual('../util/httpClient');
  return {
    ...actual,
    request: jest.fn(),
  };
});

const mockedRequest = request as jest.MockedFunction<typeof request>;

describe('ClusterDiscovery', () => {
  let discovery: ClusterDiscovery;

  beforeEach(() => {
    discovery = new ClusterDiscovery();
  });

  describe('extractAppsDomain', () => {
    it('extracts apps domain from devspaces URL', () => {
      expect(discovery.extractAppsDomain('https://devspaces.apps.mycluster-01.abc1.p1.openshiftapps.com'))
        .toBe('apps.mycluster-01.abc1.p1.openshiftapps.com');
    });

    it('extracts apps domain from console URL', () => {
      expect(discovery.extractAppsDomain('https://console-openshift-console.apps.mycluster-01.abc1.p1.openshiftapps.com'))
        .toBe('apps.mycluster-01.abc1.p1.openshiftapps.com');
    });

    it('extracts apps domain from API URL', () => {
      expect(discovery.extractAppsDomain('https://api.mycluster-01.abc1.p1.openshiftapps.com:6443'))
        .toBe('apps.mycluster-01.abc1.p1.openshiftapps.com');
    });

    it('handles URL with path and fragment', () => {
      expect(discovery.extractAppsDomain('https://devspaces.apps.cluster.example.com/dashboard/#/workspaces'))
        .toBe('apps.cluster.example.com');
    });

    it('handles direct apps domain', () => {
      expect(discovery.extractAppsDomain('https://apps.cluster.example.com'))
        .toBe('apps.cluster.example.com');
    });

    it('returns undefined for CNAME alias without apps pattern', () => {
      expect(discovery.extractAppsDomain('https://devspaces.mycompany.com'))
        .toBeUndefined();
    });

    it('returns undefined for invalid URL', () => {
      expect(discovery.extractAppsDomain('not-a-url'))
        .toBeUndefined();
    });

    it('handles URL with port in apps pattern', () => {
      expect(discovery.extractAppsDomain('https://devspaces.apps.cluster.example.com:8443'))
        .toBe('apps.cluster.example.com');
    });
  });

  describe('normalizeInputUrl', () => {
    it('adds https:// if missing', () => {
      expect(discovery.normalizeInputUrl('devspaces.apps.cluster.example.com'))
        .toBe('https://devspaces.apps.cluster.example.com');
    });

    it('preserves existing https://', () => {
      expect(discovery.normalizeInputUrl('https://devspaces.apps.cluster.example.com'))
        .toBe('https://devspaces.apps.cluster.example.com');
    });

    it('strips trailing slashes and paths', () => {
      expect(discovery.normalizeInputUrl('https://devspaces.apps.cluster.example.com/dashboard/'))
        .toBe('https://devspaces.apps.cluster.example.com');
    });

    it('trims whitespace', () => {
      expect(discovery.normalizeInputUrl('  https://devspaces.apps.cluster.example.com  '))
        .toBe('https://devspaces.apps.cluster.example.com');
    });

    it('preserves port', () => {
      expect(discovery.normalizeInputUrl('https://api.cluster.example.com:6443'))
        .toBe('https://api.cluster.example.com:6443');
    });
  });

  describe('buildDevSpacesUrl', () => {
    it('keeps a dashboard URL on a shared ingress', () => {
      expect(discovery.buildDevSpacesUrl('https://devspaces.apps.shared.example.com/dashboard/'))
        .toBe('https://devspaces.apps.shared.example.com');
    });

    it('keeps a devspaces URL that already uses the apps domain', () => {
      expect(discovery.buildDevSpacesUrl('https://devspaces.apps.mycluster-01.abc1.p1.openshiftapps.com'))
        .toBe('https://devspaces.apps.mycluster-01.abc1.p1.openshiftapps.com');
    });

    it('does not use an API server URL as the dashboard', () => {
      expect(discovery.buildDevSpacesUrl('https://api.cluster.example.com:6443'))
        .toBe('https://devspaces.apps.cluster.example.com');
    });

    it('inserts the ROSA apps label when guessing from an API URL', () => {
      expect(discovery.buildDevSpacesUrl('https://api.mycluster-01.abc1.p1.openshiftapps.com:443'))
        .toBe('https://devspaces.apps.rosa.mycluster-01.abc1.p1.openshiftapps.com');
    });

    it('still inserts the ROSA apps label when the cluster name starts with rosa-', () => {
      expect(discovery.buildDevSpacesUrl('https://api.rosa-example.f8y9.p3.openshiftapps.com:443'))
        .toBe('https://devspaces.apps.rosa.rosa-example.f8y9.p3.openshiftapps.com');
    });
  });

  describe('resolveApiUrl', () => {
    it('keeps the API server URL the user typed', () => {
      expect(discovery.resolveApiUrl(
        'https://api.cluster.example.com:6443',
        'https://api.cluster.example.com:443',
      )).toBe('https://api.cluster.example.com:6443');
    });

    it('uses the discovered API server for a dashboard URL', () => {
      expect(discovery.resolveApiUrl(
        'https://devspaces.apps.shared.example.com',
        'https://api.cluster.example.com:6443',
      )).toBe('https://api.cluster.example.com:6443');
    });
  });

  describe('discover', () => {
    const oauthMeta = {
      authorization_endpoint: 'https://oauth.example.com/oauth/authorize',
      token_endpoint: 'https://oauth.example.com/oauth/token',
    };

    beforeEach(() => {
      mockedRequest.mockReset();
    });

    it('uses a pasted API server without probing console on a guessed apps domain', async () => {
      mockedRequest.mockResolvedValue({
        statusCode: 200,
        data: JSON.stringify(oauthMeta),
        headers: {},
      });

      const endpoints = await discovery.discover('https://api.cluster.example.com:6443');

      expect(endpoints.apiUrl).toBe('https://api.cluster.example.com:6443');
      expect(mockedRequest).toHaveBeenCalledTimes(1);
      expect(mockedRequest.mock.calls[0][0].url).toContain('/.well-known/oauth-authorization-server');
    });

    it('finds the cluster from a default-domain dashboard via oauth-openshift', async () => {
      mockedRequest
        .mockRejectedValueOnce(new HttpError('HTTP 302', 302, '', {
          location: 'https://oauth-openshift.apps.cluster.example.com/oauth/authorize',
        }))
        .mockRejectedValueOnce(new Error('console missing'))
        .mockResolvedValueOnce({
          statusCode: 200,
          data: JSON.stringify(oauthMeta),
          headers: {},
        });

      const endpoints = await discovery.discover('https://devspaces.apps.cluster.example.com');

      expect(endpoints.appsDomain).toBe('apps.cluster.example.com');
      expect(endpoints.apiUrl).toBe('https://api.cluster.example.com:6443');
    });

    it('does not guess api. from a shared-ingress dashboard that redirects to Entra', async () => {
      mockedRequest.mockRejectedValue(new HttpError('HTTP 302', 302, '', {
        location: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
      }));

      await expect(discovery.discover('https://devspaces.apps.shared.example.com'))
        .rejects.toThrow(/Paste the API server URL/);
      expect(mockedRequest.mock.calls.some((call) => String(call[0].url).includes('console-openshift-console'))).toBe(false);
    });
  });
});
