// puppeteer-core is imported dynamically (optional dep); its types are referenced as `any`
// to avoid an ESM/CJS type-only-import constraint under module: node16.

/**
 * Connects to a running cloakbrowser (or any Chrome) CDP endpoint and runs work
 * inside a real (stealth) page. Used only for the steps that sit behind a JS
 * anti-bot wall (e.g. gogoanimez.to's episode-list ajax); plain HTTP is used
 * everywhere else.
 *
 * Run cloakbrowser as a CDP server (locally now, on your VM later — same image):
 *   docker run -d --name cloak -p 127.0.0.1:9222:9222 cloakhq/cloakbrowser cloakserve
 *
 * Endpoint is configurable via the `CLOAK_CDP_URL` env var (default
 * `http://localhost:9222`), so local == VM with only an env change.
 */
class BrowserFetcher {
  constructor(private readonly endpoint: string = process.env.CLOAK_CDP_URL || 'http://localhost:9222') {}

  /** Whether a CDP browser is reachable at the endpoint. */
  isAvailable = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${this.endpoint}/json/version`);
      return res.ok;
    } catch {
      return false;
    }
  };

  private connect = async (): Promise<any> => {
    let webSocketDebuggerUrl: string;
    try {
      const res = await fetch(`${this.endpoint}/json/version`);
      ({ webSocketDebuggerUrl } = await res.json());
    } catch (err) {
      throw new Error(
        `Could not reach a browser at ${this.endpoint}. Start cloakbrowser: ` +
          `docker run -d --name cloak -p 127.0.0.1:9222:9222 cloakhq/cloakbrowser cloakserve ` +
          `(or set CLOAK_CDP_URL). Cause: ${(err as Error).message}`
      );
    }
    const { default: puppeteer } = await import('puppeteer-core');
    return puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl });
  };

  /**
   * Opens a fresh page, runs `fn`, then cleans up the page and disconnects
   * (leaving the shared browser running). Returns whatever `fn` returns.
   *
   * Hardened for piracy sites: auto-closes popunder/popup tabs they spawn, and
   * blocks heavy/ad resource types so the page stays responsive. Pass
   * `allowHosts` to additionally drop every request not on those hosts (the
   * strongest ad/tracker block — use the target site's own host).
   */
  withPage = async <T>(fn: (page: any) => Promise<T>, opts: { allowHosts?: string[] } = {}): Promise<T> => {
    const browser = await this.connect();
    const page = await browser.newPage();

    // close ad/popunder windows the site tries to spawn
    page.on('popup', (popup: any) => popup?.close?.().catch(() => {}));

    const blockedTypes = new Set(['image', 'media', 'font', 'stylesheet']);
    const allow = opts.allowHosts ?? [];
    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      try {
        const url = req.url();
        if (!url.startsWith('http')) return req.continue();
        const host = new URL(url).hostname;
        const offHost = allow.length > 0 && !allow.some(h => host === h || host.endsWith(`.${h}`));
        if (offHost || blockedTypes.has(req.resourceType())) return req.abort();
        return req.continue();
      } catch {
        try {
          req.continue();
        } catch {
          /* request already handled */
        }
      }
    });

    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
      browser.disconnect();
    }
  };

  /** Closes every open page/tab in the shared browser (clears accumulated ad popunders). */
  closeStrayPages = async (): Promise<number> => {
    const browser = await this.connect();
    try {
      const pages = await browser.pages();
      let closed = 0;
      for (const p of pages) {
        await p.close().catch(() => {});
        closed++;
      }
      return closed;
    } finally {
      browser.disconnect();
    }
  };
}

export default BrowserFetcher;
