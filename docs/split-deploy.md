# Split deploy: Minecraft host + grok.me shell

Two-sided plan. The Grok App host cannot keep a Mineflayer TCP session, so the live player stays on the Java server machine and grok.me only shows that dashboard.

Target topology:

```
browser
  └─ grok.me static shell (iframe)
       └─ https://dash.<domain>   (this repo: Express + Prismarine + SSE)
            ├─ Mineflayer  →  127.0.0.1:25565  (Java 1.21.4)
            └─ HTTPS       →  api.typesafe.ai
```

Current working preview (chat sandbox) already runs this repo against `124.223.39.93:25565`. Production moves Mineflayer onto that same host and points grok.me at it.

Do not put TypeSafe API keys, RCON passwords, or basic-auth secrets in git.

---

## Side A — Minecraft server host

Machine: the Java 1.21.4 server (`124.223.39.93`). Minecraft itself stays. Add Node dashboard + HTTPS reverse proxy on the same box.

### A1. Java server (minimal)

Keep:

- version `1.21.4`
- `online-mode=false` (offline Mineflayer login)
- whitelist off, or whitelist the bot name `TypeSafeExplorer`

Suggested `server.properties` (only change what you still need):

```properties
online-mode=false
white-list=false
enforce-secure-profile=false
server-port=25565
max-players=10
view-distance=8
simulation-distance=8
difficulty=peaceful
spawn-protection=0
```

Optional:

- If no human client should join from the internet, set `server-ip=127.0.0.1` so 25565 is loopback-only.
- If humans still join, leave 25565 public and accept that offline-mode is unsafe on the open internet.

No plugins required. Seed / world reset is still: stop, set `level-seed`, delete `world` / `world_nether` / `world_the_end`, start. The dashboard cannot regenerate the world.

Bot username is always `TypeSafeExplorer`. Survival mode is required for lumber drops.

### A2. Node dashboard (this repo)

Install Node 20+, clone this repository, `npm ci --omit=dev`.

Bind the dashboard to loopback. Mineflayer must talk to the local Java port, not the public IP:

```bash
PORT=8080
BIND=127.0.0.1
MC_HOST=127.0.0.1
MC_PORT=25565
MC_VERSION=1.21.4
MC_AUTOCONNECT=1
TYPESAFE_MODEL=jev-latest
```

Leave `TYPESAFE_API_KEY` empty on disk. Operators paste it in the dashboard; it stays in process memory.

systemd unit `/etc/systemd/system/typesafe-mc.service`:

```ini
[Unit]
Description=TypeSafe Minecraft dashboard
After=network.target
# After=network.target minecraft.service
# Requires=minecraft.service

[Service]
User=typesafe
WorkingDirectory=/opt/typesafe-minecraft-demo
Environment=PORT=8080
Environment=BIND=127.0.0.1
Environment=MC_HOST=127.0.0.1
Environment=MC_PORT=25565
Environment=MC_VERSION=1.21.4
Environment=MC_AUTOCONNECT=1
ExecStart=/usr/bin/node src/server.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Health check on the host:

```bash
curl -s http://127.0.0.1:8080/api/state
# ready true, gameHost 127.0.0.1, gamePort 25565
```

Start order: Java server first, then `typesafe-mc`.

### A3. HTTPS reverse proxy

Need a DNS A record to `124.223.39.93`. Raw IP cannot get a trusted certificate; grok.me will refuse mixed `ws://` and bad TLS.

Caddy (handles ACME + WebSocket + SSE):

```caddy
dash.example.com {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
```

Paths that must pass through unchanged:

| Path | Why |
|---|---|
| `/` ` /app.js` `/index.html` | dashboard UI |
| `/view/socket.io` | Prismarine world stream (WebSocket upgrade) |
| `/view/index.js` `/worker.js` `/textures` `/blocksStates` | viewer assets |
| `/api/state` `/api/events` | snapshot + SSE |
| `POST /api/*` | key, connect, start, pause, goal |

Firewall:

- open `443` and `80` (ACME)
- do not publish `8080`
- `25565` only if human clients need it

### A4. Security on the host

The dashboard has no login today. Once it has a public hostname, anyone can Start a task.

Minimum before sharing the URL:

- Caddy `basic_auth`, or IP allowlist
- later: session login in this repo (not in this drop)

Also:

- do not commit `.env`
- do not expose RCON
- `online-mode=false` + public 25565 means anyone can join as any name

### A5. Host checklist

1. Domain A record → server IP
2. `server.properties` as above, Java process running
3. Node 20 + this repo at `/opt/typesafe-minecraft-demo`
4. systemd `typesafe-mc`
5. Caddy `dash.example.com` → `127.0.0.1:8080`
6. Browser: `https://dash.example.com` shows third-person world
7. Paste TypeSafe key, Start lumber run, confirm `/api` JSON and world movement

---

## Side B — grok.me / dashboard shell

grok.me publish is a static/SSR web app. It cannot run `mineflayer.createBot()` or hold TCP to 25565.

### B1. What grok.me keeps

A thin shell:

- title, short copy, maybe key-reminder text
- full-viewport iframe to `https://dash.example.com`
- no voxel world, no heuristic stand-in, no second TypeSafe proxy

```html
<iframe
  src="https://dash.example.com"
  title="TypeSafe Minecraft dashboard"
  allow="fullscreen"
  style="border:0;width:100%;height:100vh"
></iframe>
```

Do not split API / textures / socket.io onto grok.me. Same-origin on the host is required for the viewer.

### B2. What this repo must add (code, after host HTTPS works)

1. **Iframe embedding**
   - send `Content-Security-Policy: frame-ancestors 'self' https://*.grok.me https://*.grok.com`
   - do not send `X-Frame-Options: DENY`
2. **CORS** — `allowedOrigin` already allows `*.grok.me` / `*.grok.com` for `POST /api/*`. Keep it. SSE and socket.io are same-origin inside the iframe, so they should not need grok.me CORS if we use the iframe plan.
3. **Connect defaults** — when running on the host, default `MC_HOST=127.0.0.1`. The UI still allows Reconnect to another host/port for debugging.
4. **Optional basic-auth bypass for iframe** — if Caddy basic auth is on, grok.me iframe will prompt; that is acceptable for v1.

Rejected for v1: hosting only the HTML on grok.me and pointing `wss://dash...` + `/api` at the VPS. That needs CORS, cookie/SameSite, and socket.io `path`/`origin` changes for little gain.

### B3. Preview vs publish (current)

| Surface | Process | Minecraft |
|---|---|---|
| Chat live preview | `startup.sh` → `node src/server.cjs` on port 8080 | public IP `124.223.39.93:25565` |
| grok.me publish today | root Vite voxel app | none (old heuristic world) |
| grok.me publish target | iframe shell | iframe → host dashboard |

Until Side A HTTPS is live, do not republish grok.me; it would still ship the voxel app.

### B4. grok.me checklist

1. Side A `https://dash.example.com` works in a normal browser
2. Patch this repo: `frame-ancestors` for grok.me
3. Replace the published Grok App with the iframe shell
4. Confirm Prismarine canvas, SSE counters, and Start task work inside the iframe
5. Confirm mixed-content is absent (all `https` / `wss`)

---

## Implementation order

1. Domain + Caddy on the Java host (Side A3)
2. systemd dashboard, Bot on `127.0.0.1:25565` (Side A2)
3. Manual browser test of lumber run (Side A5)
4. `frame-ancestors` + iframe shell (Side B2 / B4)
5. Basic auth in front of the dashboard (Side A4)

Do not start Side B until `curl https://dash.example.com/api/state` returns `ready: true` from a machine that is not the server.

---

## Out of scope (this plan)

- Regenerating the world / switching seed from the dashboard
- Running Mineflayer inside grok.me
- prismarine-web-client as a human first-person client
- Putting TypeSafe keys in `.env` or git
- Changing System One primitives or Jev routing
