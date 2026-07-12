import axios, { AxiosInstance } from 'axios';
import http2 from 'http2';

/**
 * A solved Cloudflare clearance: the `cf_clearance` cookie **paired with the exact User-Agent it
 * was issued for**. Cloudflare binds the cookie to that UA string (and the solving IP), so the two
 * MUST always travel together — sending the cookie with a mismatched UA re-triggers the challenge.
 */
export interface CfClearance {
  cfClearance: string;
  /** the UA the solver's headless browser used — reuse it verbatim on every request that carries the cookie */
  userAgent: string;
  /** epoch ms the clearance was obtained (diagnostics only; expiry is detected via a 403, not a timer) */
  solvedAt: number;
}

/** a minimal, axios-shaped response from {@link http2Get} (only what callers here read). */
export interface H2Response {
  status: number;
  headers: Record<string, string>;
  /** JSON-parsed body when the response is `application/json`, otherwise the raw text */
  data: any;
}

const DEFAULT_ENDPOINT = process.env.BYPARR_URL || process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191';
const H2_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS) || 20000;

// One reused HTTP/2 session per origin. These Cloudflare edges (animepahe.pw, kwik.cx, the
// uwucdn video CDN) **reject HTTP/1.1 outright (403)** and only answer over HTTP/2 — which Node's
// `http`/axios/undici-`fetch` clients don't speak by default, so a valid cf_clearance sent over
// HTTP/1.1 still 403s. Node's built-in `http2` is the fix. Sessions are cached (connection reuse)
// and torn down + reconnected on error/close.
const sessions = new Map<string, http2.ClientHttp2Session>();

const getSession = (origin: string): http2.ClientHttp2Session => {
  const existing = sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const session = http2.connect(origin);
  session.setTimeout(H2_TIMEOUT_MS);
  const drop = () => {
    if (sessions.get(origin) === session) sessions.delete(origin);
  };
  session.on('error', drop);
  session.on('close', drop);
  session.on('goaway', drop);
  sessions.set(origin, session);
  return session;
};

/** close every pooled HTTP/2 session (lets a short-lived script exit; no-op for a long server). */
export const closeHttp2Sessions = (): void => {
  for (const s of sessions.values()) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
};

/**
 * GET a URL over **HTTP/2** (see {@link sessions} for why HTTP/1.1 clients fail against these
 * Cloudflare edges). Header names are lowercased (HTTP/2 rejects uppercase); the JSON body is
 * parsed when the response declares `application/json`. Never throws on a non-2xx — inspect
 * `status`. Provider-agnostic so both {@link CloudflareSolver} and the kwik unpacker can share it.
 */
export const http2Get = (url: string, headers: Record<string, string> = {}): Promise<H2Response> =>
  new Promise((resolve, reject) => {
    let session: http2.ClientHttp2Session;
    try {
      session = getSession(new URL(url).origin);
    } catch (err) {
      return reject(err);
    }
    const u = new URL(url);
    const reqHeaders: Record<string, string> = { ':method': 'GET', ':path': `${u.pathname}${u.search}` };
    for (const [k, v] of Object.entries(headers)) if (v != null) reqHeaders[k.toLowerCase()] = v;

    let settled = false;
    const req = session.request(reqHeaders);
    req.setTimeout(H2_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      req.close(http2.constants.NGHTTP2_CANCEL);
      reject(new Error(`HTTP/2 request timed out: ${url}`));
    });
    let status = 0;
    const resHeaders: Record<string, string> = {};
    const chunks: Buffer[] = [];
    req.on('response', h => {
      status = Number(h[':status']);
      for (const [k, v] of Object.entries(h)) if (!k.startsWith(':')) resHeaders[k] = String(v);
    });
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks).toString('utf8');
      const isJson = /application\/json/i.test(resHeaders['content-type'] ?? '');
      let data: any = body;
      if (isJson) {
        try {
          data = JSON.parse(body);
        } catch {
          /* leave as text */
        }
      }
      resolve({ status, headers: resHeaders, data });
    });
    req.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.end();
  });

/**
 * `CloudflareSolver` — a thin, provider-agnostic client for a FlareSolverr-compatible challenge
 * solver (this deployment runs **Byparr** at `http://flaresolverr:8191`, kept under the
 * `flaresolverr` container name for drop-in compatibility; both expose the same `POST /v1`
 * `{cmd:"request.get"}` API). It exists so any provider fronted by Cloudflare's **Managed
 * Challenge** (the modern Turnstile JS-VM tier that hard-403s plain clients) — currently
 * {@link AnimePahe}, and the pending `mkissa.to` provider which sits behind the identical
 * challenge — can share one solve-and-cache path rather than each reimplementing it.
 *
 * Design (deliberately small — not an abstraction layer):
 * - **Solve once, reuse many.** Solving drives a real headless browser and takes ~13–15s; a
 *   solved `cf_clearance`+UA pair then serves ordinary fast requests. We {@link solve} lazily and
 *   cache the pair, keyed by **host**, in a process-wide static map (`.animepahe.pw` and
 *   `mkissa.to` keep independent entries; provider instances in one process share the cache).
 * - **Cookie+UA are cached and sent as a pair** — see {@link CfClearance}.
 * - **Reuse requests go over HTTP/2** ({@link http2Get}) — mandatory: these edges 403 HTTP/1.1.
 * - **Auto-recover on expiry.** {@link get} sends the cached pair; if Cloudflare rejects it
 *   (403/503, or a `Just a moment…` interstitial with a 200) the cookie has expired/rotated, so we
 *   re-solve **once** and retry transparently — no manual intervention.
 * - **Concurrent-solve coalescing.** Parallel first-hits for one host share a single in-flight
 *   solve instead of launching several ~15s browser sessions.
 *
 * Configuration is env-driven so local == VM: `BYPARR_URL` (or legacy `FLARESOLVERR_URL`; default
 * `http://flaresolverr:8191`) and `BYPARR_MAX_TIMEOUT_MS` (default 60000).
 */
export class CloudflareSolver {
  /** host → last solved clearance. Static so it is shared across every provider instance in the process. */
  private static readonly cache = new Map<string, CfClearance>();
  /** host → in-flight solve, so concurrent first-hits coalesce onto one browser session. */
  private static readonly inflight = new Map<string, Promise<CfClearance>>();

  constructor(
    private readonly endpoint: string = DEFAULT_ENDPOINT,
    private readonly maxTimeoutMs: number = Number(process.env.BYPARR_MAX_TIMEOUT_MS) || 60000,
    // axios is only used for the Byparr POST (a plaintext HTTP/1.1 call to the solver); the target
    // site is always fetched over HTTP/2 via http2Get.
    private readonly client: AxiosInstance = axios.create({ timeout: Number(process.env.HTTP_TIMEOUT_MS) || 20000 })
  ) {}

  private hostOf = (url: string): string => new URL(url).host;

  /** the cached clearance for `url`'s host, if one has been solved (does not trigger a solve). */
  getCached = (url: string): CfClearance | undefined => CloudflareSolver.cache.get(this.hostOf(url));

  /** discard the cached clearance for `url`'s host (forces the next {@link get} to re-solve). */
  invalidate = (url: string): void => {
    CloudflareSolver.cache.delete(this.hostOf(url));
  };

  /**
   * Obtain (and cache) a clearance for `url`'s host via the solver, driving a real headless browser.
   * Solves the host's **origin** — `cf_clearance` is domain-wide, so one solve covers every path.
   * Concurrent calls for the same host share a single in-flight solve.
   * @param url any URL on the target host
   * @param force re-solve even if a cached pair exists (used by {@link get} on a 403)
   */
  solve = async (url: string, force = false): Promise<CfClearance> => {
    const host = this.hostOf(url);
    if (!force) {
      const cached = CloudflareSolver.cache.get(host);
      if (cached) return cached;
    }
    const existing = CloudflareSolver.inflight.get(host);
    if (existing) return existing;
    const p = this.doSolve(url, host).finally(() => CloudflareSolver.inflight.delete(host));
    CloudflareSolver.inflight.set(host, p);
    return p;
  };

  private doSolve = async (url: string, host: string): Promise<CfClearance> => {
    const origin = new URL(url).origin;
    let data: any;
    try {
      ({ data } = await this.client.post(
        `${this.endpoint}/v1`,
        { cmd: 'request.get', url: origin, maxTimeout: this.maxTimeoutMs },
        { headers: { 'Content-Type': 'application/json' }, timeout: this.maxTimeoutMs + 15000 }
      ));
    } catch (err) {
      throw new Error(`Cloudflare solver unreachable at ${this.endpoint} (${(err as Error).message})`);
    }
    if (data?.status !== 'ok' || !data?.solution)
      throw new Error(`Cloudflare solve failed for ${host}: ${data?.message ?? 'no solution returned'}`);
    const cfCookie = (data.solution.cookies ?? []).find((c: any) => c?.name === 'cf_clearance');
    const userAgent: string | undefined = data.solution.userAgent;
    if (!cfCookie?.value || !userAgent)
      throw new Error(`Cloudflare solve for ${host} returned no cf_clearance/User-Agent`);
    const clearance: CfClearance = { cfClearance: cfCookie.value, userAgent, solvedAt: Date.now() };
    CloudflareSolver.cache.set(host, clearance);
    return clearance;
  };

  /**
   * GET `url` behind Cloudflare over HTTP/2 using the cached clearance (solving first if needed). If
   * the response looks blocked (expired/rotated cookie), re-solve once and retry transparently.
   * Caller-supplied `headers` (e.g. `Referer`) are preserved; `user-agent` and the `cf_clearance`
   * cookie are injected from the clearance.
   */
  get = async (url: string, headers: Record<string, string> = {}): Promise<H2Response> => {
    let clearance = await this.solve(url);
    let res = await this.h2Get(url, clearance, headers);
    if (this.looksBlocked(res)) {
      clearance = await this.solve(url, true); // cookie expired/rotated → force a fresh solve
      res = await this.h2Get(url, clearance, headers);
    }
    return res;
  };

  private h2Get = (url: string, clearance: CfClearance, headers: Record<string, string>): Promise<H2Response> => {
    const cookie = [headers.Cookie ?? headers.cookie, `cf_clearance=${clearance.cfClearance}`].filter(Boolean).join('; ');
    return http2Get(url, { ...headers, 'user-agent': clearance.userAgent, cookie });
  };

  /** a Cloudflare block: a 403/503, or the Managed-Challenge interstitial served with a 200. */
  private looksBlocked = (res: H2Response): boolean => {
    if (res.status === 403 || res.status === 503) return true;
    const ct = String(res.headers['content-type'] ?? '');
    return ct.includes('text/html') && typeof res.data === 'string' && /just a moment|cf-mitigated/i.test(res.data);
  };
}
