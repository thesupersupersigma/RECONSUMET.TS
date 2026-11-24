# Report — task 02: TLS bake-off, rustyTLS wiring, fetch layer (→ v0.2.0)

Date: 2026-11-24. Author: thesupersupersigma (work done by Claude Code). Committed afterwards on request (see "Git"); nothing pushed.

## Plain-English summary

- **The TLS question is settled: wreq wins.** Of eight ways to make requests look like Chrome, only wreq (our fork
  rustyTLS-js, and the original wreq-js) matches a real Chrome 149 exactly — handshake, HTTP/2 settings and header
  order. It's also the fastest, and it runs on tsss-server's old no-AVX Xeon. So "rustyTLS = fork of wreq" stands.
- **Our fork builds and runs on both machines,** but only against wreq's 0.16 line. The fork's `main` is upstream's
  next version and its API no longer fits wreq-js. You need to put rustyTLS on tag **`v0.16.4`** (commands below).
- **The fetch layer exists** (`packages/core`, published name `@reconsumet/core`): one `createFetcher()` that every
  scraper, the API and the video proxy will use. It does plain or Chrome-impersonating requests per host, rate limits,
  retries, timeouts, size caps, safe redirects, the SSRF guard for proxy URLs, cookies, block-page detection and
  per-request events. 65 offline tests and 3 live tests pass.
- **Cloudflare reality check:** impersonation gets us past 3–4 of the 20 Cloudflare-protected anime sites (plain Node
  gets 1). The other ~16 challenge or block everyone — that's the solver's job (brainstorm 2.6), not TLS.
- **One privacy thing before you commit:** `tools/tls-bakeoff/reference/chrome.json` (your Chrome capture) contains your
  public IP address. The git block below strips it first.

## Bake-off result and recommendation

Full method and tables: [`docs/tls-bakeoff.md`](../tls-bakeoff.md). Highlights (both machines agree):

| | JA4 = Chrome | H2 = Chrome | header order | CF sites passed | seq req/s PC / server | runs on server |
|---|---|---|---|---|---|---|
| rustyTLS-js (our build) | ✅ | ✅ | ✅ | 4/20 | 2330 / 1053 | ✅ |
| wreq-js (npm) | ✅ | ✅ | ✅ | 4/20 | 2507 / 1267 | ✅ |
| impit | ❌ | ❌ | ✅ | 3/20 | 1361 / 906 | ✅ |
| impers (libcurl-impersonate) | ❌ (17 ext.) | ✅ | ❌ | 4/20 | 1756 / 934 | ✅ |
| cycletls (given Chrome's JA3) | ❌ (TLS 1.2) | ❌ | ❌ | 3–4/20 | 325 / 207 | ✅ |
| got-scraping | ❌ | ❌ | ❌ | 3–4/20 | 689 / 505 | ✅ |
| curl-impersonate CLI (v1) | ❌ (17 ext.) | ✅ | ❌ | 4/20 | 14 / 141 | ✅ |
| Node fetch | ❌ | ❌ | ❌ | 1/20 | 1509 / 625 | ✅ |

**Recommendation: confirm brainstorm 1.14a — rustyTLS is a fork of wreq.** Features worth porting (details, file
locations and sizes in the bake-off doc):

1. **HTTP/3 — don't port impit's.** Upstream wreq is already building HTTP/3 on BoringSSL (branches `http3`,
   `demo/h3-quic-hardening`, last commit 2026-11-07). Rebase onto it when it lands; curl-impersonate's
   `ngtcp2.patch`/`nghttp3.patch` are then the reference for Chrome's QUIC fingerprint.
2. **Fingerprint-from-strings importer (worth it, small):** CycleTLS's `StringToSpec` / `JA4RStringToSpec` /
   `NewHTTP2Fingerprint` (~300 lines of Go) reimplemented as ~300 lines of TypeScript in rustyTLS-js that turn a JA3 /
   JA4_r / Akamai capture into wreq-js's existing `CustomEmulationOptions`. Lets us clone a new Chrome from a capture
   without waiting for upstream profiles. Good first 0.2.x side quest.
3. Newer Chrome 150–152 profiles only if upstream lags (the importer covers it).

## What was built

### Part A — rustyTLS-js on our fork

- `rustyTLS-js/rust/Cargo.toml`: `[patch.crates-io] wreq = { path = "../../rustyTLS" }` (also applies to wreq-util, so
  there's one wreq in the graph). `rust/Cargo.lock` updated to the path dependency (`wreq 0.16.4`).
- README "Fork of …" notes at the top of `rustyTLS/README.md` and `rustyTLS-js/README.md`.
- **Fork version mismatch:** rustyTLS `main` (`126a0a88`, version field still 0.16.1) is upstream's next-version line:
  building against it fails in `wreq-util 0.2.0` (`no method named http2_options found for struct
  wreq::EmulationBuilder` + 6 more) and needs rustc ≥ 1.98 (`netty` git dep: 1.100). The matching code is **tag
  `v0.16.4`** (`4ddadc9d`, 2026-11-20, upstream branch `0.16.x`). I built from a read-only `git archive v0.16.4` export
  (in gitignored `out/tls-bakeoff/build/`), not from your checkout.
- Built from source and tested (rustyTLS-js's own suite, local servers):
  - **PC** (Windows, MSVC 2026): `wreq-js.win32-x64-msvc.node`, **224/224 tests pass**.
  - **tsss-server** (Xeon E5620, no AVX): built inside an `ubuntu:22.04` container (no sudo, same glibc as the host) with
    `tools/tls-bakeoff/build-rustytls-js-linux.sh`; `wreq-js.linux-x64-gnu.node` loads with the host's Node 26, **224/224
    tests pass, no "Illegal instruction"**. Build time: 5 min 41 s cold, 3 min 19 s warm.
  - Both build logs show `Compiling wreq v0.16.4 (…/rustyTLS)` and no "patch not used" warning.

### Part B — bake-off

- `tools/tls-bakeoff/bakeoff.mjs` (CLI, `--help`, same style as `scrape-indexes.mjs`), `candidates.mjs` (one adapter
  per library), `build-rustytls-js-linux.sh`, `reference/chrome.json` (yours).
- `docs/tls-bakeoff.md` — summary, method, both machines' tables, notes, fork state, porting list.
- Raw results: `out/tls-bakeoff/{pc,tsss-server}/*.json`, merged `out/tls-bakeoff/table.md` (gitignored).

### Part C — fetch layer

Workspace: `pnpm-workspace.yaml`, root `package.json` (scripts `build`, `test`, `test:live`, `lint`, `typecheck`;
`packageManager: pnpm@11.13.0`), `biome.json`, `pnpm-lock.yaml`. `.gitignore` already covered `node_modules/`, `dist/`,
`coverage/` — unchanged. Both `package.json` files at **0.2.0**; README status line + version badge updated, Discord
badge kept.

`packages/core` (`@reconsumet/core`, ESM, TS strict, Node 26, TypeScript 7, vitest 5, biome 2.6):

| file | what |
|---|---|
| `src/fetch/fetcher.ts` | `createFetcher(config)` → `request(url, opts)` / `close()`: rules, tier choice, escalation, retries, redirects, cookies, limits, events |
| `src/fetch/transports/{transport,plain,impersonate,solver}.ts` | internal `Transport` interface; undici; rustyTLS-js/wreq-js (the only file that imports it); solver stub |
| `src/fetch/classify.ts` | `ok` / `cf-challenge` / `cf-block` / `ddos-guard` / `forbidden` / `rate-limited` (also used by the bake-off tool) |
| `src/fetch/ssrf.ts` | blocked ranges, URL check, vetted DNS, validating connect lookup (no rebinding gap) |
| `src/fetch/limiter.ts` | per-host gate (concurrency + evenly spaced starts) and global semaphore |
| `src/fetch/body.ts` | read-once body: text/json/bytes/stream, size cap while streaming, completion callback |
| `src/fetch/errors.ts`, `types.ts`, `index.ts`, `src/index.ts` | typed errors and public types/exports |
| `test/*.test.ts`, `test/server.ts`, `test/peet.live.test.ts` | unit tests (local servers) and the live suite |
| `docs/fetch.md` | usage, config, tiers, behaviour, limits |

Notes on choices:
- The impersonate tier depends on the **npm `wreq-js@^3.2.0`** for now: it's the same package name and API as
  rustyTLS-js, it runs on tsss-server, and it keeps `pnpm install` working without a local Rust build. Switching to our
  build is a one-line dependency change once we publish it (see deployment).
- wreq-js 3.2.0 only accepts DNS pinning (`resolve`) on a transport, not per request (per-request `resolve` is
  unreleased on wreq-js master). So untrusted impersonate requests get their own pinned transport, closed when the body
  ends — correct, but unpooled (marked `shortcut:` in the code).
- Escalation is opt-in (`escalate: { ttlMs }`), as the task said "optional".

## Test results (all run, all on the PC)

```
pnpm build       → tsc ok
pnpm typecheck   → ok
pnpm lint        → biome: Checked 28 files, no errors
pnpm test        → Test Files 3 passed (3), Tests 65 passed (65)
pnpm test:live   → Test Files 1 passed (1), Tests 3 passed (3)   (tls.peet.ws: plain ≠ Chrome; impersonate = Chrome JA4 + H2; solver throws)
rustyTLS-js npm test → 224/224 on the PC and 224/224 on tsss-server
```

Unit tests cover: classifier; SSRF ranges (incl. Tailscale CGNAT, IMDS v4/v6, mapped/NAT64/6to4/Teredo),
mixed DNS answers, per-hop redirect checks, literal IPs, schemes; retries/backoff, Retry-After (honoured, and too-long
→ give up), network-error retry, no POST retry; rate limit spacing; per-host and global concurrency; total timeout
(headers and body), connect timeout; size cap (header and streaming); redirects, max hops, 303→GET, credential
stripping cross-origin; blocks → `BlockedError`; escalation + remembering (real wreq-js against a local server);
streaming; read-once body; cookie jar; events. `pnpm test` was not run on tsss-server (it only ran the bake-off and
rustyTLS-js's suite there).

## What didn't work, and what you need to run

1. **SSH:** `ssh thesupersupersigma@tsss-server` (Tailscale) asks for a browser login ("Tailscale SSH requires an
   additional check"). I used its LAN address, whose host key is already in your `known_hosts`.
2. **tsss-server has no Rust/cmake/clang** and system Node is 20. Nothing to install: builds run in Docker
   (`build-rustytls-js-linux.sh`), and Node 26 is in user space at `~/reconsumet-bakeoff/node`. To clean up later:
   `rm -rf ~/reconsumet-bakeoff && docker volume rm rustytls-cargo-registry && docker image rm ubuntu:22.04`.
3. **PC toolchain for building rustyTLS-js yourself.** Your Rust is the 1.97 MSI; BoringSSL on Windows needs NASM and
   libclang; long paths break the build. I used an isolated toolchain in gitignored `RECONSUMET.TS/out/toolchain/`
   (rustup with rustc 1.100, NASM 3.02). Permanent setup (PowerShell; the first line needs an admin shell):
   ```powershell
   New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
   winget install Rustlang.Rustup NASM.NASM
   [Environment]::SetEnvironmentVariable('LIBCLANG_PATH', 'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\Llvm\x64\bin', 'User')
   ```
   (Uninstall the "Rust stable MSVC 1.97" MSI so rustup's `cargo` is the one on PATH.) Build from **PowerShell, not Git
   Bash**: under Git Bash, cmake died with `0xc0000142` (DLL init failure). Then, after the rustyTLS checkout below:
   ```powershell
   cd rustyTLS-js; $env:HUSKY='0'; npm ci --ignore-scripts; npm run build; npm test
   ```
   `--ignore-scripts`/`HUSKY=0` stop husky's `prepare` from rewriting your git hooks config.
4. Not done: tsss-server's `pnpm test` of `@reconsumet/core` (covered by the PC run + the bake-off there). The
   bake-off's CycleTLS and curl-impersonate processes aren't counted in "peak RSS".

## Deployment note (not built)

The API runs in Docker via Coolify on tsss-server. Ways to get the native addon into the image:

| option | how | cost |
|---|---|---|
| a. npm prebuilt `wreq-js` | `pnpm install` in a Debian/Ubuntu-based Node image (glibc, not Alpine) | nothing; **verified to run on tsss-server today**; but it's upstream's code, not our patches |
| b. Build in the Dockerfile from the forks | multi-stage: rust + build-essential/cmake/perl/pkg-config/libclang-dev builder (`build-rustytls-js-linux.sh` is the recipe) | ~4–6 min of Xeon CPU per deploy without a cache, ~2 GB builder; needs both fork repos in the build context |
| c. Our own npm package with a baseline x64 build | GitHub Actions (ubuntu-22.04, glibc 2.35, default `x86-64` target — no `target-cpu=native`) builds `rustyTLS-js` on tag and publishes e.g. `@thesupersupersigma/rustytls-js` + its `linux-x64-gnu` binding via napi | CI setup once; fast deploys; same as a. afterwards |
| d. Prebuilt artifact | CI attaches the `.node` to a GitHub release; Dockerfile downloads it | like c. without npm, but hand-rolled loading |

**Recommendation:** use **a** while our patch set is empty (that's today: `@reconsumet/core` already depends on it).
Switch to **c** with the first real rustyTLS patch (e.g. the fingerprint importer), keeping **b** as the fallback if
publishing is ever a problem. Avoid `-C target-cpu=native` anywhere: a build on the PC would crash on the Xeon.

## Suggested edits to `brainstorm.md` (not applied)

- **1.14** → add: "Superseded by the 0.2 bake-off (2026-11-24): wreq/rustyTLS first; impit's TLS (JA4) and HTTP/2
  fingerprint don't match Chrome."
- **1.14a** → add an update: "Bake-off done 2026-11-24 (`RECONSUMET.TS/docs/tls-bakeoff.md`): **confirmed**. Only
  wreq matches Chrome 149 (JA4, Akamai H2, header order); fastest; runs on tsss-server (fork build and npm prebuilt).
  impit's HTTP/3 is not ported — upstream wreq is building HTTP/3 (`demo/h3-quic-hardening`). First port: a
  JA3/JA4_r/Akamai string importer (from CycleTLS's idea) in rustyTLS-js."
- **1.23** → add: "rustyTLS must sit on wreq's 0.16.x line (tag `v0.16.4`, branch `rustytls`); `main` is upstream's next
  version and breaks wreq-util 0.2. rustyTLS-js uses it through `[patch.crates-io]`."
- **0.1 Facts** → add: "tsss-server (2026-11-24): system Node 20, no Rust/cmake/clang, user in the `docker` group;
  Tailscale SSH needs a browser check, the LAN address works with the existing key. npm `wreq-js` prebuilt runs on the
  no-AVX Xeon." and "v1's TLS_IMPERSONATE_HOSTS (2026-11-24): overcdn.site and uwucdn.top don't resolve, vid-cdn.xyz is a
  redirect loop, xin-cdn.xyz 403s everyone, flixcloud.cc and anidb.app answer plain requests on `/`."
- **2.6** → add: "0.2 measurement: of 20 Cloudflare-challenge anime sites, TLS impersonation passes 3–4 (plain 1); ~16 need
  the solver."
- **5. Change log** → "2026-11-24: milestone 0.2 done — TLS bake-off (wreq confirmed), rustyTLS-js on the fork,
  `@reconsumet/core` fetch layer, v0.2.0."

## Scope notes (things I'd trim or question next time)

- Eight candidates × two machines answered a question the brainstorm already expected (wreq). Next bake-offs (solver,
  2.6) can start with 3–4 serious candidates.
- The plain-vs-impersonate escalation will matter less than expected: no gated host from v1 distinguishes them on `/`
  anymore. Real numbers come from 0.3's source URLs.

## Git

Committed (not pushed) on 2026-11-24, after stripping your IP and per-connection randoms from
`tools/tls-bakeoff/reference/chrome.json`:

- **RECONSUMET.TS** (`master`): `feat(tools): tls bake-off of 8 impersonation clients`,
  `feat(core): fetch layer with plain, impersonate and solver tiers`, `chore(release): 0.2.0`, tag `v0.2.0`.
- **rustyTLS**: new branch `rustytls` from tag `v0.16.4` with `docs: note this is the rustyTLS fork of wreq`
  (`main` is untouched). Consider making `rustytls` the default branch on GitHub.
- **rustyTLS-js** (`master`): `build: use the local rustyTLS fork for wreq`. Its `rust/Cargo.lock` points at
  `wreq 0.16.4`, which now matches the checked-out rustyTLS.

Push when ready:

```sh
cd RECONSUMET.TS
git push origin master v0.2.0
```

```sh
cd rustyTLS
git push -u origin rustytls
```

```sh
cd rustyTLS-js
git push origin master
```

## What's next — 0.3

First two sources + AniList→source matching with season handling (v1's two-tier idea), built on `createFetcher()`:
per-source host rules (Referer/Origin, rate limits), `untrusted: true` wherever a URL comes from a page, and the
classifier for each source's health. Re-test v1's gated CDNs on real video/API URLs to decide which rules need
`tier: 'impersonate'`.
