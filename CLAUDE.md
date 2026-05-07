# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

```bash
npm install          # first time only
node server.js       # starts game server on http://localhost:3000
```

There are no tests and no build step. The game is immediately playable by opening `http://localhost:3000` after starting the server.

## Git & GitHub workflow

Every meaningful change must be committed with a clean, descriptive message and pushed to `origin main` (https://github.com/jeshaiahsuncuaco/retro-arena). Never commit `node_modules/`.

## Architecture

This is a two-file multiplayer game: a Node.js server and a single-page HTML client.

### `server.js` — authoritative game server

Express serves `game.html` on port 3000. A `ws.WebSocketServer` shares the same HTTP server and runs the game.

**Single global `state` object:**
- `players` — `Map<id, player>` where each player holds position, HP, kills, movement keys, aim angle, and respawn timer
- `enemies` — `Map<id, enemy>` with type (`grunt` | `runner`), position, HP, and speed
- `wave`, `waveTimer`, `waveActive` — wave progression state

**Game loop** runs via `setInterval` at 50 ms (20 ticks/sec). Each tick, in order:
1. Move players from their stored `keys` state; tick down respawn timers
2. Move enemies toward the nearest living player (direct vector chase); deal contact damage on overlap
3. Resolve all `pendingSlashes` — cone hit detection using `dist2` + `angleDiff`; credit kills to the slashing player
4. Manage wave transitions: when all enemies die, start `waveTimer` countdown; when it hits zero, call `spawnWave(n)`
5. `broadcast(snapshot())` — serialize full state as JSON to every connected WebSocket client

**WebSocket messages the server handles:** `JOIN`, `KEYS`, `ANGLE`, `SLASH`, `PING`

**WebSocket messages the server emits:** `WELCOME`, `SNAPSHOT` (every tick), `SLASH_VFX`, `HIT`, `PLAYER_DIED`, `PLAYER_RESPAWNED`, `PLAYER_LEFT`, `PONG`

Slashes are validated server-side. The client shows a local VFX arc immediately on click without waiting for server confirmation. The server broadcasts `SLASH_VFX` so other players see the arc too.

**Key tuning constants** (all at the top of `server.js`):
- `TICK_MS = 50` — server tick interval
- `WORLD_W / WORLD_H = 2400` — arena dimensions in pixels
- `PLAYER_SPEED = 3` — pixels per tick
- `SLASH_RANGE = 120`, `SLASH_ARC_HALF = 35°` — sword cone geometry
- `RESPAWN_MS = 3000`, `WAVE_PAUSE_MS = 4000`
- Wave formula: `5 + n * 3` enemies per wave; runners appear from wave 3 at 30%

### `game.html` — single-file client

All CSS, HTML, and JavaScript in one file. No framework, no build step.

**Client state** is a single `C` object holding the WebSocket, player ID, two snapshot buffers (`C.prev`, `C.curr`), camera position, input state, VFX list, and screen-shake counters.

**Render pipeline** (60 fps via `requestAnimationFrame`):
1. Compute `alpha = (now - C.lastSnap) / TICK_MS` and interpolate between `C.prev` and `C.curr` snapshots
2. Update camera — clamp to world bounds, centered on local player
3. `ctx.translate(-cam)` then draw: world grid → enemy HP bars → enemies → players → slash VFX
4. HTML overlay (`#hud`) is updated each snapshot via `updateHUD()` — no canvas text for UI

**Interpolation:** `interpSnap()` lerps `x`, `y`, and `angle` (with wrap-aware `lerpAngle`) between the two most recent snapshots. This smooths 20 Hz server updates into 60 fps rendering.

**Input:** `keydown`/`keyup` send `KEYS` only on change. `mousemove` sends `ANGLE` throttled to 20/s. `click` sends `SLASH` and immediately shows a local VFX arc.

**Rendering is entirely procedural** — no sprite sheets or image assets. Players, grunts, and runners are built from `fillRect` / `arc` calls. The sword is drawn in local (rotated) space pointing right, so rotating the player's `ctx` makes it always point toward the mouse.

**Slash VFX** is an expanding arc drawn with `ctx.arc`, fading over 320 ms, with radial flash lines and random sparkle `fillRect` particles.

### `tictactoe.html`

Standalone browser Tic Tac Toe game (no server required). Single file, no relation to the multiplayer game. Includes minimax AI for vs-CPU mode.
