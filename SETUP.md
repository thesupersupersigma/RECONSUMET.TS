# VM Setup (Oracle / Linux)

Bootstrap the anime API on a fresh VM. Repo layout: `consumet/` (the scraper library) +
`api/` (the Fastify HTTP API). See `consumet/CLAUDE.md` for the full technical brief.

## 0. Prereqs (install once)
```bash
# Node 20+ and pnpm
curl -fsSL https://fnm.vercel.app/install | bash && exec $SHELL   # or use your distro's node
npm i -g pnpm
# Python 3.10–3.14 (for ViperTLS) + venv
sudo apt-get update && sudo apt-get install -y python3 python3-venv python3-pip
# Docker is already installed on the VM (used for cloakbrowser)
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

## 4. ViperTLS (TLS-impersonation sidecar, for the CDN Cloudflare gate)
```bash
python3 -m venv .venv-tls
.venv-tls/bin/pip install vipertls
.venv-tls/bin/vipertls install-browsers
# (validation of ViperTLS vs the gated m3u8 is still PENDING — see CLAUDE.md)
```

## 5. cloakbrowser (stealth browser for the episode-list step)
```bash
docker run -d --name cloak --restart unless-stopped \
  -p 127.0.0.1:9222:9222 cloakhq/cloakbrowser cloakserve
curl -s http://localhost:9222/json/version    # expect a webSocketDebuggerUrl
```

## 6. Run the API
```bash
cd api
PORT=3000 \
CLOAK_CDP_URL=http://localhost:9222 \
PUBLIC_URL=https://api.thesupersuperanime.lol \
pnpm start
# health: curl http://localhost:3000/
```

## 7. Expose at api.thesupersuperanime.lol (Cloudflare Tunnel — no open ports, hides VM IP)
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
- **Pending:** validate ViperTLS fetches the gated megaplay m3u8, then wire `/proxy` to fetch the
  CDN through it (see CLAUDE.md "the TLS-fingerprint blocker"). This is the last mile for playback.
- Gate the public API (API key / referer-allowlist) + add Redis caching before heavy use.
- Keep Docker memory bounded; `docker stop cloak` when idle.
- Run cloakbrowser + cloudflared + the API as systemd services (or docker-compose) for durability.
