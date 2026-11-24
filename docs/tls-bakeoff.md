# TLS bake-off (milestone 0.2)

## Summary in plain English

We tried eight ways of making HTTP requests "look like Chrome" and ran each one through the same tests on the PC and on
tsss-server (the old Xeon without AVX).

- **Only wreq (our fork rustyTLS-js, and the original wreq-js) looks exactly like real Chrome.** Its TLS handshake (JA4),
  HTTP/2 settings and header order all match the Chrome 149 capture saved from your browser. Every other library differs
  somewhere: impit's handshake and HTTP/2 settings are off, curl-impersonate/impers send one extra TLS extension and a
  different header order, CycleTLS can't even do TLS 1.3 from a JA3 string, got-scraping and plain Node fetch don't
  try.
- **It is also the fastest:** 1.1–2× the throughput of impit and impers, 5–170× that of CycleTLS and v1's
  curl-impersonate subprocess (the slowest by far). And **it runs on tsss-server**, both our from-source build and the
  npm prebuilt.
- **On real sites, impersonation helps but doesn't work miracles.** Against the 20 Cloudflare-protected anime sites, every
  real impersonator got 3–4 sites, plain Node fetch got 1. The other ~16 show a Cloudflare challenge or firewall block
  to *everyone*: that needs the solver tier (brainstorm 2.6), not a better TLS library.
- **v1's "fingerprint-gated" CDNs no longer separate the tools:** 3 of the 6 hosts are dead (DNS gone or redirect
  loop), `xin-cdn.xyz` refuses everyone, and `flixcloud.cc` / `anidb.app` answer everyone, plain fetch included, on
  their root page. (The gating in v1 was on video/API paths; root pages can't show it. 0.3 re-tests real source URLs.)

**Recommendation: confirmed — rustyTLS = fork of wreq** (brainstorm 1.14a), used from Node through rustyTLS-js. Nothing
in the bake-off comes close on fingerprint accuracy or speed. The fork has to track wreq's **0.16.x** line for now (see
"Fork state" below), and the features worth taking from the others are listed at the end — the biggest one, HTTP/3, is
already being built upstream, so we wait for it rather than port impit's.

## Method

Tool: `tools/tls-bakeoff/bakeoff.mjs` (Node, no dependencies; `--help`). Each candidate is installed in its own folder
under `out/tls-bakeoff/deps/` and runs in its own child process, so a crash (e.g. "Illegal instruction") only kills that
candidate's run. Raw JSON: `out/tls-bakeoff/<machine>/`; merged tables: `out/tls-bakeoff/table.md` (`--merge`).

| candidate | what was tested | Chrome profile used |
|---|---|---|
| rustyTLS-js | our build: rustyTLS-js master + rustyTLS at tag `v0.16.4`, built from source on each machine | `chrome` → `chrome_149` |
| wreq-js | npm 3.2.0 prebuilt (the control for our build) | `chrome_149` |
| impit | npm 0.14.9 | `chrome` (newest alias) |
| impers | npm 0.1.3 (Node binding of libcurl-impersonate, downloads libcurl-impersonate 2.3.2 on first run) | `chrome` (newest) |
| cycletls | npm 2.0.5 (Go subprocess) | none built in: given the reference capture's JA3, JA4_r and Akamai strings |
| got-scraping | npm 4.2.2 (header generator only, the control for "headers aren't enough") | header-generator chrome/windows |
| curl-impersonate | lexiforest CLI v2.3.2, one process per request (v1's approach, the baseline) | `chrome152` (newest) |
| fetch | Node 26 built-in fetch with a Chrome User-Agent (no-impersonation control) | — |

wreq-likes use a session (pooled connections), as wreq-js's README recommends; everything else uses its normal API.

1. **Fingerprint** — `GET https://tls.peet.ws/api/all`, compared with `tools/tls-bakeoff/reference/chrome.json` (Chrome
   149 on Windows, captured by the user). Compared: JA4; JA3 with the extension list sorted (Chrome shuffles extension
   order on every connection, so raw JA3 hashes never repeat, even for Chrome itself); the Akamai HTTP/2 fingerprint
   (SETTINGS, WINDOW_UPDATE, priority, pseudo-header order); the full request header order; negotiated HTTP version.
2. **v1's fingerprint-gated hosts** — root URL of `flixcloud.cc, overcdn.site, vid-cdn.xyz, xin-cdn.xyz, anidb.app,
   uwucdn.top`; status, final URL, classified with the fetch layer's own classifier (`packages/core/src/fetch/classify.ts`).
3. **Cloudflare-challenge anime sites** — the 20 entries in `out/source-index/sources.json` with `check.cfChallenge`;
   status + class (`cf-challenge` / `cf-block` / `forbidden` / `ok`). No solving.
4. **Performance** — local HTTPS server (Node http2 with HTTP/1.1 fallback, self-signed cert, 1 KiB body): 5 warm-up
   requests, 500 sequential, then 500 at concurrency 32. Peak RSS = the candidate's Node process
   (`process.resourceUsage().maxRSS`); CycleTLS's Go process and curl's processes are not included.
5. **Practical** — install size, did it install/load, plus documented features (stream, proxy, cookies, H2/H3, WS,
   profiles, license, maintenance).

Politeness: one request per third-party host per candidate per run, hosts one at a time 1.5 s apart, candidates one
after another (≥ 40 s between two requests to the same host). On tsss-server the gated-host test was re-run once for
cycletls, fetch and curl-impersonate after improving error reporting (12 requests).

Single run per machine: treat performance differences under ~20 % as noise.

## Results

### pc

Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz (16 threads), win32-x64, Node v26.4.0, run 2026-11-24T05:41:40.885Z

#### Fingerprint vs real Chrome

| candidate | version | profile | loads | HTTP | JA4 | JA3 (sorted) | Akamai H2 | header order | JA4 value |
|---|---|---|---|---|---|---|---|---|---|
| rustyTLS-js | 3.2.0 (local fork build) | chrome_149 | ✅ | h2 | ✅ | ✅ | ✅ | ✅ | `t13d1516h2_8daaf6152771_d8a2da3f94cd` |
| wreq-js | 3.2.0 | chrome_149 | ✅ | h2 | ✅ | ✅ | ✅ | ✅ | `t13d1516h2_8daaf6152771_d8a2da3f94cd` |
| impit | 0.14.9 | chrome (newest alias) | ✅ | h2 | ❌ | ❌ | ❌ | ✅ | `t13d1516h2_8daaf6152771_02713d6af862` |
| impers | 0.1.3 | chrome (newest alias) | ✅ | h2 | ❌ | ❌ | ✅ | ❌ | `t13d1517h2_8daaf6152771_cb7bf5808d99` |
| cycletls | 2.0.5 | manual: reference JA3 + JA4_r + Akamai | ✅ | h2 | ❌ | ✅ | ❌ | ❌ | `t12d1516h2_8daaf6152771_1d539a4c69fc` |
| got-scraping | 4.2.2 | header-generator chrome/windows | ✅ | h2 | ❌ | ❌ | ❌ | ❌ | `t13d1513h2_8daaf6152771_ff9cead5a15b` |
| curl-impersonate | v2.3.2 | chrome152 | ✅ | h2 | ❌ | ❌ | ✅ | ❌ | `t13d1517h2_8daaf6152771_cb7bf5808d99` |
| fetch | 8.5.0 | none (Chrome User-Agent header only) | ✅ | h2 | ❌ | ❌ | ❌ | ❌ | `t13d5212h1_b262b3658495_8e6e362c5eac` |

#### v1's fingerprint-gated hosts

| site | rustyTLS-js | wreq-js | impit | impers | cycletls | got-scraping | curl-impersonate | fetch |
|---|---|---|---|---|---|---|---|---|
| flixcloud.cc | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok |
| overcdn.site | dead (DNS) | dead (DNS) | dead (DNS) | dead (DNS) | 421 ok | dead (DNS) | dead (DNS) | dead (DNS) |
| vid-cdn.xyz | redirect loop | redirect loop | redirect loop | redirect loop | no response (0) | redirect loop | redirect loop | redirect loop |
| xin-cdn.xyz | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden |
| anidb.app | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok |
| uwucdn.top | dead (DNS) | dead (DNS) | dead (DNS) | dead (DNS) | 421 ok | dead (DNS) | dead (DNS) | dead (DNS) |
| **ok (status < 400, not blocked)** | **2/6** | **2/6** | **2/6** | **2/6** | **2/6** | **2/6** | **2/6** | **2/6** |

#### Cloudflare-challenge sites (from source-index)

| site | rustyTLS-js | wreq-js | impit | impers | cycletls | got-scraping | curl-impersonate | fetch |
|---|---|---|---|---|---|---|---|---|
| animepahe.pw | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| www.crunchyroll.com | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 403 cf-challenge |
| mgread.io | 200 ok | 200 ok | 403 cf-challenge | 200 ok | 200 ok | 200 ok | 200 ok | 403 cf-challenge |
| www.wcostream.tv | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 403 cf-challenge |
| otakutsu.cc | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 403 cf-challenge | 200 ok | 200 ok |
| pimpanime.nl | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| ramenflix.com | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| anime-dunya.com | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden |
| watchanimeworld.one | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block |
| anikumo.cc | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| animesilo.cc | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block |
| animefire.one | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block |
| animeout.xyz | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| animesrbija.com | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block |
| anizm.net | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| www.blkom.com | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| goyabu.to | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| jkanime.net | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| kuramanime.com | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| ogladajanime.pl | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| **ok (status < 400, not blocked)** | **4/20** | **4/20** | **3/20** | **4/20** | **4/20** | **3/20** | **4/20** | **1/20** |

#### Performance (local HTTPS server, 1 KiB body)

| candidate | seq req/s | seq p50 ms | seq p95 ms | c32 req/s | c32 p50 ms | c32 p95 ms | errors | peak RSS MB |
|---|---|---|---|---|---|---|---|---|
| rustyTLS-js | 2330 | 0.42 | 0.62 | 8743 | 3.27 | 6.52 | 0 | 98.3 |
| wreq-js | 2507 | 0.38 | 0.56 | 10065 | 2.94 | 5.64 | 0 | 96.9 |
| impit | 1361 | 0.71 | 0.93 | 5063 | 5.92 | 11.62 | 0 | 103.1 |
| impers | 1756 | 0.56 | 0.66 | 3319 | 6.74 | 9.75 | 0 | 97 |
| cycletls | 325 | 3.02 | 3.94 | 858 | 35.96 | 45.14 | 0 | 93.1 |
| got-scraping | 689 | 1.37 | 1.99 | 1471 | 18.8 | 30.15 | 0 | 183.9 |
| curl-impersonate | 14 | 69.51 | 91.99 | 111 | 266.92 | 461.8 | 0 | 97.4 |
| fetch | 1509 | 0.61 | 1.01 | 3773 | 7.96 | 11.1 | 0 | 131 |

#### Practical

| candidate | installed & loads | install MB | browser profiles | stream | proxy | cookies | H2 | H3 | WebSocket | license | maintenance |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rustyTLS-js | ✅ | 10.6 | 133 | yes | http/https/socks | yes (session jar) | yes | no | yes | MIT (wreq: Apache-2.0) | ours; upstream very active |
| wreq-js | ✅ | 8.3 | 133 | yes | http/https/socks | yes (session jar) | yes | no | yes | MIT (wreq: Apache-2.0) | very active (renovate, frequent releases) |
| impit | ✅ | 10.1 | 24 | yes (fetch Response.body) | http/https/socks | yes (tough-cookie compatible jar) | yes | yes (opt-in) | no | Apache-2.0 | active (Apify) |
| impers | ✅ | 3.3 | 47 | yes | http/https/socks | yes | yes | yes | yes | MIT (curl-impersonate: MIT) | active, alpha (0.1.x) |
| cycletls | ✅ | 126.9 | 0 | yes (responseType stream) | http/socks | manual | yes | yes (forceHTTP3) | yes | GPL-3.0 | slow (last npm release 2025-10) |
| got-scraping | ✅ | 3.4 | 0 | yes | http/https | yes (tough-cookie) | yes | no | no | Apache-2.0 | end of life per Apify |
| curl-impersonate | ✅ | 4.2 | 46 | yes (stdout) | all curl proxies | cookie file | yes | yes | yes (curl ws) | MIT | active (lexiforest) |
| fetch | ✅ | 0 | 0 | yes | via undici ProxyAgent | no | yes (Node 26 / undici 8 offers h2) | no | yes (WebSocket global) | MIT | Node core |

### tsss-server

Intel(R) Xeon(R) CPU           E5620  @ 2.40GHz (16 threads), linux-x64, Node v26.4.0, run 2026-11-24T05:22:54.728Z

#### Fingerprint vs real Chrome

| candidate | version | profile | loads | HTTP | JA4 | JA3 (sorted) | Akamai H2 | header order | JA4 value |
|---|---|---|---|---|---|---|---|---|---|
| rustyTLS-js | 3.2.0 (local fork build) | chrome_149 | ✅ | h2 | ✅ | ✅ | ✅ | ✅ | `t13d1516h2_8daaf6152771_d8a2da3f94cd` |
| wreq-js | 3.2.0 | chrome_149 | ✅ | h2 | ✅ | ✅ | ✅ | ✅ | `t13d1516h2_8daaf6152771_d8a2da3f94cd` |
| impit | 0.14.9 | chrome (newest alias) | ✅ | h2 | ❌ | ❌ | ❌ | ✅ | `t13d1516h2_8daaf6152771_02713d6af862` |
| impers | 0.1.3 | chrome (newest alias) | ✅ | h2 | ❌ | ❌ | ✅ | ❌ | `t13d1517h2_8daaf6152771_cb7bf5808d99` |
| cycletls | 2.0.5 | manual: reference JA3 + JA4_r + Akamai | ✅ | h2 | ❌ | ✅ | ❌ | ❌ | `t12d1516h2_8daaf6152771_1d539a4c69fc` |
| got-scraping | 4.2.2 | header-generator chrome/windows | ✅ | h2 | ❌ | ❌ | ❌ | ❌ | `t13d1513h2_8daaf6152771_ff9cead5a15b` |
| curl-impersonate | v2.3.2 | chrome152 | ✅ | h2 | ❌ | ❌ | ✅ | ❌ | `t13d1517h2_8daaf6152771_cb7bf5808d99` |
| fetch | 8.5.0 | none (Chrome User-Agent header only) | ✅ | h2 | ❌ | ❌ | ❌ | ❌ | `t13d5212h1_b262b3658495_8e6e362c5eac` |

#### v1's fingerprint-gated hosts

| site | rustyTLS-js | wreq-js | impit | impers | cycletls | got-scraping | curl-impersonate | fetch |
|---|---|---|---|---|---|---|---|---|
| flixcloud.cc | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok |
| overcdn.site | dead (DNS) | dead (DNS) | dead (DNS) | dead (DNS) | 421 ok | dead (DNS) | dead (DNS) | dead (DNS) |
| vid-cdn.xyz | redirect loop | redirect loop | redirect loop | redirect loop | no response (0) | redirect loop | redirect loop | redirect loop |
| xin-cdn.xyz | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden |
| anidb.app | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok |
| uwucdn.top | dead (DNS) | dead (DNS) | dead (DNS) | dead (DNS) | 421 ok | dead (DNS) | dead (DNS) | dead (DNS) |
| **ok (status < 400, not blocked)** | **2/6** | **2/6** | **2/6** | **2/6** | **2/6** | **2/6** | **2/6** | **2/6** |

#### Cloudflare-challenge sites (from source-index)

| site | rustyTLS-js | wreq-js | impit | impers | cycletls | got-scraping | curl-impersonate | fetch |
|---|---|---|---|---|---|---|---|---|
| animepahe.pw | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| www.crunchyroll.com | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 403 cf-challenge |
| mgread.io | 200 ok | 200 ok | 403 cf-challenge | 200 ok | 403 cf-challenge | 200 ok | 200 ok | 403 cf-challenge |
| www.wcostream.tv | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 403 cf-challenge |
| otakutsu.cc | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok | 200 ok |
| pimpanime.nl | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| ramenflix.com | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| anime-dunya.com | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden | 403 forbidden |
| watchanimeworld.one | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block |
| anikumo.cc | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| animesilo.cc | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block |
| animefire.one | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block |
| animeout.xyz | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| animesrbija.com | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block | 403 cf-block |
| anizm.net | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| www.blkom.com | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| goyabu.to | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| jkanime.net | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| kuramanime.com | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| ogladajanime.pl | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge | 403 cf-challenge |
| **ok (status < 400, not blocked)** | **4/20** | **4/20** | **3/20** | **4/20** | **3/20** | **4/20** | **4/20** | **1/20** |

#### Performance (local HTTPS server, 1 KiB body)

| candidate | seq req/s | seq p50 ms | seq p95 ms | c32 req/s | c32 p50 ms | c32 p95 ms | errors | peak RSS MB |
|---|---|---|---|---|---|---|---|---|
| rustyTLS-js | 1053 | 0.88 | 1.28 | 3263 | 9.23 | 13.72 | 0 | 90.4 |
| wreq-js | 1267 | 0.74 | 1.13 | 3519 | 8.37 | 14.98 | 0 | 90.2 |
| impit | 906 | 1.01 | 1.47 | 2387 | 12.98 | 17.44 | 0 | 100.5 |
| impers | 934 | 1.01 | 1.22 | 1522 | 16.12 | 21.67 | 0 | 97 |
| cycletls | 207 | 4.12 | 5.67 | 520 | 56.37 | 75.78 | 0 | 90.3 |
| got-scraping | 505 | 1.8 | 3 | 777 | 41.23 | 52.39 | 0 | 196.2 |
| curl-impersonate | 141 | 6.58 | 9.04 | 394 | 69.23 | 112.74 | 0 | 97.8 |
| fetch | 625 | 1.5 | 2.17 | 1101 | 26.7 | 44.39 | 0 | 149 |

#### Practical

| candidate | installed & loads | install MB | browser profiles | stream | proxy | cookies | H2 | H3 | WebSocket | license | maintenance |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rustyTLS-js | ✅ | 9.4 | 133 | yes | http/https/socks | yes (session jar) | yes | no | yes | MIT (wreq: Apache-2.0) | ours; upstream very active |
| wreq-js | ✅ | 9.3 | 133 | yes | http/https/socks | yes (session jar) | yes | no | yes | MIT (wreq: Apache-2.0) | very active (renovate, frequent releases) |
| impit | ✅ | 10.3 | 24 | yes (fetch Response.body) | http/https/socks | yes (tough-cookie compatible jar) | yes | yes (opt-in) | no | Apache-2.0 | active (Apify) |
| impers | ✅ | 4.5 | 47 | yes | http/https/socks | yes | yes | yes | yes | MIT (curl-impersonate: MIT) | active, alpha (0.1.x) |
| cycletls | ✅ | 126.9 | 0 | yes (responseType stream) | http/socks | manual | yes | yes (forceHTTP3) | yes | GPL-3.0 | slow (last npm release 2025-10) |
| got-scraping | ✅ | 3.4 | 0 | yes | http/https | yes (tough-cookie) | yes | no | no | Apache-2.0 | end of life per Apify |
| curl-impersonate | ✅ | 31.8 | 47 | yes (stdout) | all curl proxies | cookie file | yes | yes | yes (curl ws) | MIT | active (lexiforest) |
| fetch | ✅ | 0 | 0 | yes | via undici ProxyAgent | no | opt-in (allowH2) | no | yes (WebSocket global) | MIT | Node core |

### Notes on the results

- **tsss-server runs everything.** No "Illegal instruction" from any candidate. wreq-js's npm prebuilt works on the
  no-AVX Xeon too, which matters for deployment (see the 02 report). rustyTLS-js built from source passes its own test
  suite there (224/224) and on the PC (224/224).
- **rustyTLS-js vs wreq-js:** same fingerprints; our build is ~7–17 % slower in this single run (wreq 0.16.4 vs 0.16.3
  and a different toolchain — not investigated, likely within noise; re-measure if it matters).
- **impit** sends Chrome's cipher list but a different extension set (JA4 `…_02713d6af862`) and its HTTP/2 SETTINGS are
  its Rust library's defaults, not Chrome's (known: impit issue #385). It was blocked by `mgread.io` on both
  machines (cycletls on one).
- **impers / curl-impersonate** (same libcurl-impersonate core) match Chrome's HTTP/2 fingerprint but send 17 TLS
  extensions where Chrome 149 sends 16 and order headers differently. Their newest profile is Chrome 152, so part of
  the difference may be Chrome 150+ changes rather than a flaw; against a Chrome 149 capture it doesn't match.
- **cycletls** negotiated TLS 1.2 (`t12…`) from Chrome's JA3 string and its HTTP/2 fingerprint differs; it reports
  transport failures as status `0` / `421` instead of errors.
- **got-scraping** has realistic headers but Node's TLS (JA4 `t13d1513h2`); it still passed 3–4 CF sites, the same as
  real impersonators, which says those 3–4 sites gate on headers/HTTP-2 more than on TLS.
- **Plain fetch** (JA4 `t13d5212h1`: 52 ciphers, no browser offers that) got 1/20 CF sites; impersonation adds
  crunchyroll.com, mgread.io and wcostream.tv.
- **curl-impersonate CLI** (v1): 14 req/s sequential on Windows, 141 on Linux — process spawn per request. It's the one
  approach we're definitely leaving behind.

## Fork state (rustyTLS ↔ rustyTLS-js)

- rustyTLS-js pins `wreq 0.16.x` (`wreq = "0.16.3"` in `rust/Cargo.toml`; wreq-util 0.2.0 needs `wreq 0.16`).
- rustyTLS `main` is upstream's development line for the next version: its `Cargo.toml` still says 0.16.1, but its API
  has moved on. Building rustyTLS-js against it fails in `wreq-util 0.2.0`
  (`no method named http2_options found for struct wreq::EmulationBuilder`, plus 6 more errors), and it needs rustc ≥
  1.98 (its git dependency `netty` needs 1.100).
- The matching code is **tag `v0.16.4`** (2026-11-20, on upstream branch `0.16.x`). Built from a `git archive` of that
  tag, rustyTLS-js compiles `wreq v0.16.4 (../rustyTLS)` and passes its test suite on both machines.
- `rust/Cargo.toml` gets `[patch.crates-io] wreq = { path = "../../rustyTLS" }`, and `rust/Cargo.lock` must point at it
  (`cargo update -p wreq`) — otherwise cargo silently keeps crates.io wreq and only prints
  "patch `wreq` was not used in the crate graph". (That happened once during this task and was caught.)

## Worth porting into rustyTLS / rustyTLS-js

| feature | from | where it lives there | rough size | verdict |
|---|---|---|---|---|
| HTTP/3 (QUIC) | impit | `impit/src/http3.rs` (~90 lines: DNS HTTPS-record + `Alt-Svc` discovery and cache) + hooks in `impit/src/impit.rs` (~60 lines); the QUIC stack itself is reqwest's `http3` feature (quinn + h3) over impit's patched rustls | 150 lines of discovery; the transport can't be ported (rustls/quinn vs our BoringSSL) | **Don't port. Upstream wreq is already building HTTP/3** on BoringSSL: branches `http3` and `demo/h3-quic-hardening` (2026-11-07, `src/client/h3_client/{connect,dns,pool}.rs`). Rebase onto it when it lands on 0.16.x/next. |
| Chrome's QUIC/HTTP-3 fingerprint | curl-impersonate (via impers) | `patches/ngtcp2.patch` (20 KB) + `patches/nghttp3.patch` (13 KB): QUIC transport parameters, their order, H3 SETTINGS | reference data, ~200 lines of settings once wreq's H3 exists | **Later**, as the data source for an H3 emulation profile once upstream H3 lands. |
| Fingerprint from strings (JA3 / JA4_r / Akamai → profile) | cycletls | `cycletls/utils.go`: `StringToSpec` (~140 lines), `JA4RStringToSpec` (~130 lines); `cycletls/http2.go`: `NewHTTP2Fingerprint` (~65 lines) | ~300 lines of TypeScript in rustyTLS-js producing its existing `CustomEmulationOptions` | **Worth it (small):** lets us clone a fingerprint captured from a real browser (like `reference/chrome.json`) the day Chrome changes, without waiting for a new upstream profile. No Rust needed — wreq-js already accepts custom emulation. |
| Newer Chrome profiles (150–152) | curl-impersonate | `tests/signatures/chrome15{0,1,2}*.yaml` (~3 KB each) | per profile ~100 lines of emulation data | **Only if upstream lags.** wreq profiles live in `wreq-util` (separate crate); with the string importer above, a capture is enough. |
| Realistic header sets | got-scraping (header-generator) | `header-generator` package (Bayesian network over real browser headers) | — | **No.** wreq already sends each profile's real default headers in the right order. |
| Python bindings, Firefox via rustls | impit | `impit-python/`, patched `rustls` | — | **No.** Not needed (TypeScript project); wreq already has Firefox profiles. |

Everything above is Apache-2.0 (impit, wreq), MIT (curl-impersonate, impers) or GPL-3.0 (cycletls) — all usable in a
GPL-3.0-or-later project; cycletls code could only be ported into rustyTLS-js (MIT) as a clean reimplementation, not a
copy, to keep that repo MIT.
