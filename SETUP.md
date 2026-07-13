# VM Setup (Oracle / Linux)

Bootstrap the anime API on a fresh VM. Repo layout: `consumet/` (the scraper library) +
`api/` (the Fastify HTTP API). See `consumet/CLAUDE.md` for the full technical brief.

## 0. Prereqs (install once)
```bash
# Node 20+ and pnpm
curl -fsSL https://fnm.vercel.app/install | bash && exec $SHELL   # or use your distro's node
npm i -g pnpm
```

## 1. Clone (private repo)
```bash
gh repo clone <your-username>/<repo>    # or: git clone git@github.com:<you>/<repo>.git
cd <repo>
```

## 2. Build the library
```bash
cd consumet
pnpm install
npx tsc -p tsconfig.json     # emits dist/ (ignore the ~12 pre-existing strict-type warnings)
cd ..
```

## 3. API deps
```bash
cd api && pnpm install && cd ..
```

## 4. curl-impersonate (TLS-impersonation, for the CDN Cloudflare/JA3 gate)
Some CDNs (reanime's `fetch5.flixcloud.cc` + `*.overcdn.site`) gate on the TLS/HTTP2
fingerprint — plain Node `fetch` gets a `403` "Attention Required". The `/proxy`
routes those hosts through **curl-impersonate** so they fetch like a real browser.
```bash
# grab a static build for your arch from lexiforest/curl-impersonate releases
#   (Oracle Ampere = linux-aarch64; x86 VM = linux-x86_64)
mkdir -p /opt/curl-impersonate && cd /opt/curl-impersonate
curl -fsSL -o ci.tar.gz \
  https://github.com/lexiforest/curl-impersonate/releases/latest/download/curl-impersonate-linux-aarch64.tar.gz
tar xf ci.tar.gz && cd -
# quick check: should print 200 on a normal site
/opt/curl-impersonate/curl-impersonate --impersonate chrome124 -s -o /dev/null -w '%{http_code}\n' https://example.com
```
The API auto-uses it when `CURL_IMPERSONATE_BIN` is set (see step 6). Prefer the
single-binary `--impersonate` build so per-request headers override the profile
defaults cleanly. (A `pip install curl_cffi` + tiny wrapper works too if you'd
rather not manage a binary.)

## 5. Run the API
```bash
cd api
PORT=3000 \
PUBLIC_URL=https://api.thesupersuperanime.lol \
CURL_IMPERSONATE_BIN=/opt/curl-impersonate/curl-impersonate \
CURL_IMPERSONATE_ARGS="--impersonate chrome124" \
pnpm start
# health: curl http://localhost:3000/   (look for tlsImpersonation.enabled=true)
# TLS_IMPERSONATE_HOSTS defaults to "flixcloud.cc,overcdn.site"; add more if needed.
```

## 6. Expose at api.thesupersuperanime.lol (Cloudflare Tunnel — no open ports, hides VM IP)
```bash
# install cloudflared, then:
cloudflared tunnel login
cloudflared tunnel create anime-api
# route the subdomain -> local API
cloudflared tunnel route dns anime-api api.thesupersuperanime.lol
# config (~/.cloudflared/config.yml):
#   tunnel: <tunnel-id>
#   credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json
#   ingress:
#     - hostname: api.thesupersuperanime.lol
#       service: http://localhost:3000
#     - service: http_status:404
cloudflared tunnel run anime-api    # (run as a systemd service for persistence)
```

## Endpoints
- `GET /search?q=<query>`
- `GET /info/:anilistId`            — provider mappings (available sources)
- `GET /episodes/:anilistId?provider=Gogoanime`
- `GET /watch?provider=Gogoanime&episodeId=<id>&type=sub`
- `GET /proxy?url=<enc>&ref=<enc>`  — HLS/subtitle proxy

## Notes / next steps
- **TLS gate: SOLVED** via curl-impersonate (step 4). Verified e2e on reanime/flixcloud:
  decrypt m3u8 → impersonated fetch (200) → XOR-deobfuscate playlists → stream TS segments +
  `.ass` subs. Set `CURL_IMPERSONATE_BIN` and it just works; without it those hosts 403.
- Gate the public API (API key / referer-allowlist) + add Redis caching before heavy use.
- Run cloudflared + the API as systemd services (or docker-compose) for durability.
