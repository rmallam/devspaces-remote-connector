import * as https from 'https';
import { getHttpsAgent } from './tls';
import { Logger } from './Logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  /** Follow redirects (default: false) */
  followRedirects?: boolean;
}

export interface HttpResponse {
  statusCode: number;
  data: string;
  headers: Record<string, string | string[] | undefined>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly responseHeaders: Record<string, string | string[] | undefined> = {}
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// ─── Configuration ───────────────────────────────────────────────────────────

const MAX_RESPONSE_SIZE = 1_048_576; // 1MB
const DEFAULT_TIMEOUT = 15_000; // 15s
const MAX_REDIRECTS = 5;

// ─── Shared Agent ────────────────────────────────────────────────────────────

let sharedAgent: https.Agent | undefined;

/**
 * Get or create the shared HTTPS agent with system CAs loaded.
 * The agent is created once and reused for all requests, providing
 * connection pooling and consistent TLS trust configuration.
 */
function getAgent(): https.Agent {
  if (!sharedAgent) {
    sharedAgent = getHttpsAgent();
  }
  return sharedAgent;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Make an HTTPS request with the shared TLS-configured agent.
 *
 * All HTTPS calls in the extension should use this function to ensure
 * enterprise CAs are trusted consistently.
 *
 * @throws HttpError for non-2xx responses
 * @throws Error for network/timeout failures
 */
export async function request(opts: HttpRequestOptions): Promise<HttpResponse> {
  return doRequest(opts, 0);
}

/**
 * Convenience: GET request that parses JSON response.
 */
export async function getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await request({ url, method: 'GET', headers });
  return JSON.parse(res.data) as T;
}

/**
 * Convenience: POST with form-encoded body.
 */
export async function postForm(url: string, params: Record<string, string>, headers?: Record<string, string>): Promise<HttpResponse> {
  const body = new URLSearchParams(params).toString();
  return request({
    url,
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
      ...headers,
    },
  });
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function doRequest(opts: HttpRequestOptions, redirectCount: number): Promise<HttpResponse> {
  const logger = Logger.getInstance();
  const parsed = new URL(opts.url);

  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT;
    let settled = false;
    let wall: ReturnType<typeof setTimeout> | undefined;

    const succeed = (value: HttpResponse) => {
      if (settled) { return; }
      settled = true;
      if (wall) { clearTimeout(wall); }
      resolve(value);
    };
    const fail = (err: Error) => {
      if (settled) { return; }
      settled = true;
      if (wall) { clearTimeout(wall); }
      reject(err);
    };

    const reqOptions: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: opts.method ?? 'GET',
      timeout: timeoutMs,
      agent: getAgent(),
      headers: {
        Accept: 'application/json',
        ...opts.headers,
      },
    };

    const req = https.request(reqOptions, (res) => {
      // Handle redirects
      if (opts.followRedirects && res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (wall) { clearTimeout(wall); }
        if (redirectCount >= MAX_REDIRECTS) {
          fail(new Error(`Too many redirects (max ${MAX_REDIRECTS})`));
          res.resume();
          return;
        }
        // This request is done. The follow-up request has its own deadline.
        settled = true;
        res.resume();
        doRequest({ ...opts, url: res.headers.location }, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > MAX_RESPONSE_SIZE) {
          req.destroy();
          fail(new Error('Response too large'));
        }
      });

      res.on('end', () => {
        const statusCode = res.statusCode ?? 0;
        const response: HttpResponse = {
          statusCode,
          data,
          headers: res.headers as Record<string, string | string[] | undefined>,
        };

        if (statusCode >= 200 && statusCode < 300) {
          succeed(response);
        } else {
          const truncated = data.slice(0, 200);
          logger.debug(`HTTP ${statusCode} from ${opts.method ?? 'GET'} ${parsed.hostname}${parsed.pathname}: ${truncated}`);
          fail(new HttpError(
            `HTTP ${statusCode}: ${truncated}`,
            statusCode,
            data,
            res.headers as Record<string, string | string[] | undefined>
          ));
        }
      });
    });

    // Socket timeout does not cover a DNS lookup or a TCP handshake that never
    // completes. A shared ingress often blackholes the guessed console host,
    // and the connection spinner waits until this returns.
    wall = setTimeout(() => {
      req.destroy();
      fail(new Error(`Request to ${parsed.hostname} timed out`));
    }, timeoutMs);

    req.on('error', (err) => {
      fail(new Error(`Request to ${parsed.hostname} failed: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      fail(new Error(`Request to ${parsed.hostname} timed out`));
    });

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}
