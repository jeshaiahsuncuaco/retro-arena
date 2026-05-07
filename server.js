const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const PORT = 3000;
const TICK_MS = 50;
const WORLD_W = 2400;
const WORLD_H = 2400;
const PLAYER_SPEED = 3;
const PLAYER_HP = 100;
const SLASH_RANGE = 120;
const SLASH_ARC_HALF = 35 * Math.PI / 180;
const RESPAWN_MS = 3000;
const WAVE_PAUSE_MS = 4000;

const COLORS = ['#e94560','#4ecdc4','#ffe66d','#a8dadc','#ff6b6b','#c3f73a','#f7a8d8','#7bc8f6'];

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'game.html')));

// ── Game state ────────────────────────────────────────────────────────────────

const state = {
  players: new Map(),
  enemies:  new Map(),
  wave:        0,
  waveTimer:   WAVE_PAUSE_MS, // countdown to first wave
  waveActive:  false,
  nextId:      1,
  colorIdx:    0,
  tickCount:   0,
};

const pendingSlashes = [];

function uid() { return state.nextId++; }

function dist2(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return dx * dx + dy * dy;
}

function angleDiff(a, b) {
  return ((b - a) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Spawning ──────────────────────────────────────────────────────────────────

function spawnWave(n) {
  const count = 5 + n * 3;
  const runnerChance = n >= 3 ? 0.30 : 0;
  for (let i = 0; i < count; i++) {
    const isRunner = Math.random() < runnerChance;
    const edge = Math.floor(Math.random() * 4);
    const m = 30;
    let x, y;
    if (edge === 0)      { x = Math.random() * WORLD_W; y = m; }
    else if (edge === 1) { x = WORLD_W - m; y = Math.random() * WORLD_H; }
    else if (edge === 2) { x = Math.random() * WORLD_W; y = WORLD_H - m; }
    else                 { x = m; y = Math.random() * WORLD_H; }

    const id = uid();
    state.enemies.set(id, {
      id, x, y, angle: 0,
      type:  isRunner ? 'runner' : 'grunt',
      hp:    isRunner ? 60 : 100,
      maxHp: isRunner ? 60 : 100,
      speed: isRunner ? 2.8 : 1.2,
    });
  }
  state.waveActive = true;
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(str);
  }
}

function snapshot() {
  return {
    type: 'SNAPSHOT',
    tick: state.tickCount,
    wave: state.wave,
    waveTimer: state.waveTimer,
    waveActive: state.waveActive,
    players: [...state.players.values()].map(p => ({
      id: p.id, x: p.x, y: p.y, angle: p.angle,
      hp: p.hp, maxHp: p.maxHp,
      score: p.score, kills: p.kills,
      name: p.name, dead: p.dead, color: p.color,
    })),
    enemies: [...state.enemies.values()].map(e => ({
      id: e.id, x: e.x, y: e.y, angle: e.angle,
      hp: e.hp, maxHp: e.maxHp, type: e.type,
    })),
  };
}

// ── Game loop ─────────────────────────────────────────────────────────────────

setInterval(() => {
  state.tickCount++;

  // 1. Move players
  for (const p of state.players.values()) {
    if (p.dead) {
      p.respawnTimer -= TICK_MS;
      if (p.respawnTimer <= 0) {
        p.dead = false;
        p.hp   = p.maxHp;
        p.x    = WORLD_W / 2 + (Math.random() - 0.5) * 300;
        p.y    = WORLD_H / 2 + (Math.random() - 0.5) * 300;
        broadcast({ type: 'PLAYER_RESPAWNED', playerId: p.id });
      }
      continue;
    }
    const k = p.keys;
    if (k.up)    p.y -= PLAYER_SPEED;
    if (k.down)  p.y += PLAYER_SPEED;
    if (k.left)  p.x -= PLAYER_SPEED;
    if (k.right) p.x += PLAYER_SPEED;
    p.x = clamp(p.x, 12, WORLD_W - 12);
    p.y = clamp(p.y, 12, WORLD_H - 12);
  }

  // 2. Move enemies & deal contact damage
  for (const e of state.enemies.values()) {
    let nearest = null, minD2 = Infinity;
    for (const p of state.players.values()) {
      if (p.dead) continue;
      const d2 = dist2(e, p);
      if (d2 < minD2) { minD2 = d2; nearest = p; }
    }
    if (!nearest) continue;

    const ang = Math.atan2(nearest.y - e.y, nearest.x - e.x);
    e.angle = ang;
    e.x += Math.cos(ang) * e.speed;
    e.y += Math.sin(ang) * e.speed;
    e.x = clamp(e.x, 0, WORLD_W);
    e.y = clamp(e.y, 0, WORLD_H);

    // Contact damage (enemy touches player)
    if (minD2 < 25 * 25) {
      nearest.hp -= 0.6; // ~12 hp/s at 20 ticks
      if (nearest.hp <= 0 && !nearest.dead) {
        nearest.hp   = 0;
        nearest.dead = true;
        nearest.respawnTimer = RESPAWN_MS;
        broadcast({ type: 'PLAYER_DIED', playerId: nearest.id });
      }
    }
  }

  // 3. Resolve slashes
  while (pendingSlashes.length) {
    const { playerId, angle } = pendingSlashes.shift();
    const p = state.players.get(playerId);
    if (!p || p.dead) continue;

    const killed = [];
    for (const e of state.enemies.values()) {
      if (e.hp <= 0) continue;
      const d2 = dist2(p, e);
      if (d2 > SLASH_RANGE * SLASH_RANGE) continue;
      const eAng = Math.atan2(e.y - p.y, e.x - p.x);
      if (Math.abs(angleDiff(angle, eAng)) > SLASH_ARC_HALF) continue;

      const dmg = 34;
      e.hp -= dmg;
      broadcast({ type: 'HIT', enemyId: e.id, damage: dmg, killerId: playerId });

      if (e.hp <= 0) {
        killed.push(e.id);
        p.kills++;
        p.score += 10;
      }
    }
    for (const id of killed) state.enemies.delete(id);
  }

  // 4. Wave management
  if (state.waveActive && state.enemies.size === 0) {
    state.waveActive = false;
    state.waveTimer  = WAVE_PAUSE_MS;
  }
  if (!state.waveActive) {
    state.waveTimer -= TICK_MS;
    if (state.waveTimer <= 0) {
      state.wave++;
      spawnWave(state.wave);
    }
  }

  // 5. Broadcast snapshot
  broadcast(snapshot());

}, TICK_MS);

// ── WebSocket connections ─────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'JOIN': {
        playerId = uid();
        const color = COLORS[state.colorIdx++ % COLORS.length];
        state.players.set(playerId, {
          id: playerId,
          x: WORLD_W / 2 + (Math.random() - 0.5) * 300,
          y: WORLD_H / 2 + (Math.random() - 0.5) * 300,
          angle: 0,
          hp: PLAYER_HP, maxHp: PLAYER_HP,
          score: 0, kills: 0,
          name: String(msg.name || 'Player').slice(0, 16),
          dead: false, respawnTimer: 0,
          color,
          keys: { up: false, down: false, left: false, right: false },
        });
        ws.send(JSON.stringify({ type: 'WELCOME', id: playerId, color, worldW: WORLD_W, worldH: WORLD_H }));
        break;
      }
      case 'KEYS': {
        const p = state.players.get(playerId);
        if (p) p.keys = { up: !!msg.up, down: !!msg.down, left: !!msg.left, right: !!msg.right };
        break;
      }
      case 'ANGLE': {
        const p = state.players.get(playerId);
        if (p && !p.dead) p.angle = Number(msg.angle) || 0;
        break;
      }
      case 'SLASH': {
        const p = state.players.get(playerId);
        if (p && !p.dead) {
          pendingSlashes.push({ playerId, angle: Number(msg.angle) || 0 });
          broadcast({ type: 'SLASH_VFX', playerId, angle: Number(msg.angle) || 0, x: p.x, y: p.y });
        }
        break;
      }
      case 'PING':
        ws.send(JSON.stringify({ type: 'PONG', ts: msg.ts }));
        break;
    }
  });

  ws.on('close', () => {
    if (playerId) {
      state.players.delete(playerId);
      broadcast({ type: 'PLAYER_LEFT', playerId });
    }
  });
});

server.listen(PORT, () => console.log(`Retro Arena running → http://localhost:${PORT}`));
