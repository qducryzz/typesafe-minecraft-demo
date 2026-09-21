# Local deploy (leave Grok preview)

`main` at this handoff: high-level Jev + Mineflayer pathfinder.
Atomic primitives stay on branch `jev/atomic-controller`.

Do not keep using Grok App Builder preview. That sandbox idles, recycles, and remounts the template gallery when Node or the Minecraft TCP session dies. Publish to grok.me cannot hold Mineflayer.

## What you run locally

Same machine as the Java 1.21.4 server, or a machine that can reach it:

```
browser  →  this dashboard (Node)  →  127.0.0.1:25565  (or your Java host)
                 ↓
          api.typesafe.ai  (jev-latest)
```

Default `CONTROL_MODE=highlevel`. Jev chooses `harvest_nearest` / `pickup` / `explore` / `return_home`. Pathfinder walks and digs. No images are sent to Jev.

## Install

Need Node 20+ and npm.

```bash
git clone https://github.com/qducryzz/typesafe-minecraft-demo.git
cd typesafe-minecraft-demo
git checkout main
npm ci
```

Copy `.env.example` to `.env` on the machine only. Never commit it.

Same-host Java server:

```bash
TYPESAFE_MODEL=jev-latest
CONTROL_MODE=highlevel
MC_HOST=127.0.0.1
MC_PORT=25565
MC_VERSION=1.21.4
MC_AUTOCONNECT=1
PORT=8080
BIND=127.0.0.1
```

Paste the TypeSafe key in the dashboard after start, or set `TYPESAFE_API_KEY` in `.env`.

```bash
node --env-file=.env src/server.cjs
```

Open the printed URL. Status should become Ready. Lumber objective stays fixed.

Java server: `1.21.4`, `online-mode=false`, Survival, Peaceful. The bot name is generated from the host's network adapter MAC digest as `TypeSafeBot` plus five characters; use the name shown by the dashboard. Prepare solid ground near trees for that player. Full host notes: [split-deploy.md](split-deploy.md).

## Public URL later

Bind Node to loopback, put Caddy/nginx + HTTPS in front, then optionally iframe that origin from grok.me. Do not expect Grok preview or grok.me Publish to replace this process.
