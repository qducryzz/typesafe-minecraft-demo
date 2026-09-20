# Jev atomic-action controller (branch snapshot)

Branch: `jev/atomic-controller`  
Base: `main` at the remote-Java dashboard drop (Prismarine in-page viewer, TypeSafe key in session, host/port reconnect, editable objective).

This branch records the **direct-control / atomic primitive** design used to test **Jev** (`jev-latest`) through TypeSafe System One. It is not the earlier high-level lumber/flag batch controller (pathfind + harvest/build batches).

## Claim

One System One decision selects **one short Minecraft control**. Mineflayer executes that primitive only. There is no automatic pathfinding, batch mining, or batch placing inside the running loop.

Jev sees structured world state (`state` + filtered `criteria`), not pixels.

## Loop

```
observe(bot, goal, history)
  + controlMode: "direct"
  + task progress
  + direct = observeDirect(bot, task)
       → POST https://api.typesafe.ai/v1/systemone
            model: jev-latest
            questions.movement.type: choice
            criteria: currently legal primitives
       → validate choice + probabilities
       → execute(bot, task, choice, seen)   // ~250 ms pulse or one look/dig/place
       → log latest request/raw/outcome
```

Freshness: if the player moved ≥ 0.8 blocks during inference, or the round trip exceeded 5 s, the answer is logged and not executed. HTTP 429/5xx and the 10 s timeout share a three-attempt retry budget.

## System One payload

`src/decisions.cjs` `requestFor` when `controlMode === 'direct'`:

```json
{
  "model": "jev-latest",
  "state": { "scenario": "lumber|flag", "controlMode": "direct", "goal": "...", "task": {}, "direct": {}, "position": {} },
  "questions": {
    "movement": {
      "type": "choice",
      "instructions": "<phaseInstructions>",
      "criteria": { "<action>": "<description or distance estimate object>" }
    }
  }
}
```

Expected answer: `answers.movement.choice`, `confidence`, `probabilities` over **exactly** the offered keys, summing to 1.

Dashboard fields **Actual TypeSafe input / response** are this request and the raw HTTP JSON.

## Primitive catalogue (`src/direct-actions.cjs`)

| Action | Duration / effect |
|---|---|
| `forward` `backward` `left` `right` | 250 ms hold; no auto-steer |
| `jump_forward` | jump + forward 250 ms (one-block rise) |
| `turn_left` `turn_right` | yaw ±30°, no walk |
| `aim_mine_0` `aim_mine_1` | look at `direct.miningTargets[i]` |
| `aim_drop_0` `aim_drop_1` | face drop approach; no pickup path |
| `aim_place_0` `aim_place_1` | look at support face for `placementTargets[i]` |
| `equip_shears` `equip_red_wool` `equip_white_wool` | hotbar only |
| `mine` | dig the eligible crosshair block once |
| `place` | place one held wool on the aimed blueprint cell |
| `inspect_flag` | verify 338 cells |
| `wait` | 250 ms idle |

Illegal actions are **removed from `criteria`**, not left for the model to avoid:

- obstructed / hazardous movement (`movementSafe`)
- `mine` unless `canMine`
- `place` unless `canPlace`
- gather-stage place/wool-equip; build-stage mine/shears
- already-held equipment, missing inventory, already-aimed visible place targets

Building movement criteria may include estimated horizontal distance before/after a pulse toward `placementTargets[0]`. That is geometry, not a route.

## What code still owns

- observations, nearest two mine/place/drop candidates, relative forward/right
- lumber win: 10 **new** logs then home within 2 blocks; 5 minute budget
- flag blueprint, supply beds, 25 minute budget
- collision vetoes, Survival-only mining, crosshair eligibility
- Prismarine third-person view of the real Java world

Jev does not choose coordinates. It chooses among named primitives.

## Runtime at this snapshot

- Bot: Mineflayer offline `TypeSafeExplorer`, protocol 1.21.4
- Default Java backend: `MC_HOST` / `MC_PORT` (preview used a remote dedicated server; production split-deploy puts the bot on `127.0.0.1:25565` — see `docs/split-deploy.md`)
- Viewer: patched Prismarine bundle mounted in `#view` (no nested iframe)
- Key: pasted in the dashboard, held in process memory, `Authorization: Bearer` only to TypeSafe
- Objective textarea feeds `state.goal`; lumber completion rules stay in `src/task.cjs`

## Key files

| File | Role |
|---|---|
| `src/direct-actions.cjs` | primitive list, filters, Jev instructions |
| `src/direct-control.cjs` | `observeDirect` + `execute` |
| `src/decisions.cjs` | System One request / validate / `jev-latest` |
| `src/server.cjs` | loop, remote connect, key, goal, viewer attach |
| `src/viewer-bundle.cjs` | in-page WebGL mount |
| `public/index.html` `public/app.js` | dashboard, probabilities, raw JSON |

## Not this branch

- High-level `harvest_nearest` / `build_maple_leaf` batch control (still in `decisions.cjs` for `controlMode !== 'direct'`, unused by the live loop)
- Voxel / heuristic grok.me stand-in
- World seed regeneration from the dashboard
- Running Mineflayer inside grok.me (see split-deploy)
