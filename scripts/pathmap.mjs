#!/usr/bin/env node
/**
 * pathmap.mjs -- L2 v2: per-tile path knowledge with costs, TTLs and learning.
 *
 * Spec (user, 2026-11-07):
 *   - one record per tile: state/kind/cost/need/src/at/ttl
 *   - 1 tile = 0.2 game-seconds; all "clear vs detour" decisions use that
 *   - three sources: map_info (warps/size), look (grid scan), walk (bump feedback)
 *   - conflict priority: event > walk > look > map_info
 *   - no permanent blocks: two contradictions downgrade a tile to unknown
 *   - write immediately after acting; merge-write via temp file + rename
 *   - unknowns are passable only with a +2s probe penalty
 *
 * Storage: saves/<saveId>/pathmap/<Location>.json
 *   {"schema":2,"map":"Town","size":[130,110],"tiles":{"x,y":{...}}}
 *
 * CLI:
 *   node pathmap.mjs scan  [--radius 20]
 *   node pathmap.mjs plan  --to x,y [--from x,y] [--json]
 *   node pathmap.mjs go    --to x,y [--max 40]
 *   node pathmap.mjs info
 *   node pathmap.mjs clear --at x,y              (clear the tile you face)
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = process.env.SDV_BRIDGE || 'http://localhost:7850';

// Which PowerShell to drive: PowerShell 7 ("pwsh") by default, falling back to
// Windows PowerShell 5.1 if 7 is not installed. Override with SDV_POWERSHELL.
const PS_CANDIDATES = [process.env.SDV_POWERSHELL, 'pwsh', 'powershell'].filter(Boolean);
let _psExe = null;
function psExe() {
  if (_psExe) return _psExe;
  for (const exe of PS_CANDIDATES) {
    try {
      execFileSync(exe, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true });
      _psExe = exe;
      return exe;
    } catch { /* not installed - try the next one */ }
  }
  _psExe = 'powershell';
  return _psExe;
}

const SAVES = process.env.STARDEW_SAVES
  || 'C:/Users/<you>/AppData/Roaming/StardewValley/Saves';

// ── constants from the spec ────────────────────────────────────────────────
const TILE_SECONDS = 0.2;      // walking one tile
const CLEAR_EXTRA = 0.3;       // handling cost on top of the action itself
const UNKNOWN_PROBE_PENALTY = 2.0;  // game-seconds to gamble on an unknown tile
const WARP_SECONDS = 1.5;
const SEASON_DAYS = 28;

const CLEAR_TABLE = {
  weed: { cost: 0.5, tool: 'Scythe', hits: 1, stamina: 0 },
  twig: { cost: 0.7, tool: 'Axe', hits: 1, stamina: 0 },
  stone: { cost: 1.5, tool: 'Pickaxe', hits: 1, stamina: 2 },
  tree: { cost: 4.0, tool: 'Axe', hits: 5, stamina: 10 },
};

const STATS = { learned: 0, changed: 0 };

const PRIORITY = { event: 4, walk: 3, look: 2, map_info: 1 };

// ── TTL / decay ────────────────────────────────────────────────────────────
// Records age: the world changes under us (weeds regrow, a season flips, crops
// are planted). A record older than its TTL is no longer trusted:
//   * a tile we cleared (src=event) — weeds/twigs come back after ~3 days;
//   * a tile only ever seen by a scan or walked once — trust it a week;
//   * a season change invalidates everything alive (grass, crops, forage).
// Walls stay walls; they do not move.
const TTL_DAYS = { event: 3, look: 7, walk: 7, map_info: 365 };

/** Stamp a tile patch with the day/season it was observed in. */
function stamp(patch, clock) {
  if (!clock) return patch;
  return { ...patch, dd: clock.day, season: clock.season };
}

/**
 * Downgrade one record if it is stale. Returns the record (same object when the
 * record is still fresh).
 */
function decayTile(rec, clock) {
  if (!clock || !rec || rec.state === 'unknown') return rec;
  const dd = typeof rec.dd === 'number' ? rec.dd : clock.day;
  const age = clock.day - dd;
  const seasonChanged = Boolean(rec.season) && rec.season !== clock.season;
  const ttl = typeof rec.ttlDays === 'number' ? rec.ttlDays : (TTL_DAYS[rec.src] ?? 7);
  const stale = seasonChanged || age > ttl;
  if (!stale) return rec;
  // A tile we failed to clear (too big / wrong tool) is a wall *for now*; let it
  // be re-tested after the TTL instead of staying blocked forever.
  if (rec.state === 'block' && rec.need !== 'clear_failed' && rec.need !== 'walk_blocked') return rec;
  // A cleared weed/twig tile regrows as clearable, not as an unknown: the plan
  // should price in "cut it again" instead of paying the probe penalty.
  if (rec.state === 'walk' && (rec.cleared === 'weed' || rec.cleared === 'twig')) {
    const spec = CLEAR_TABLE.weed;
    return {
      state: 'clearable', kind: 'weed', cost: spec.cost,
      need: { tool: spec.tool, stamina: spec.stamina, hits: spec.hits },
      src: 'decay', at: clock.hhmm, dd: clock.day, season: clock.season,
      ttlDays: TTL_DAYS.event,
    };
  }
  return { state: 'unknown', src: 'decay', at: clock.hhmm, dd: clock.day, season: clock.season };
}


// ── tiny utils ─────────────────────────────────────────────────────────────
const key = (x, y) => `${x},${y}`;
const parseXY = (s) => s.split(',').map(Number);

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  const body = await res.json();
  return body;
}

async function getState() {
  const s = await api('/state');
  if (!s.ok || !s.worldReady) throw new Error('world not ready: ' + JSON.stringify(s).slice(0, 200));
  return s;
}

/** Absolute day number + minutes since 06:00, for TTL arithmetic. */
function clockOf(state) {
  const t = state.time || {};
  const seasonIdx = ['spring', 'summer', 'fall', 'winter'].indexOf(t.season || 'spring');
  const day = ((t.year || 1) - 1) * 4 * SEASON_DAYS + seasonIdx * SEASON_DAYS + ((t.dayOfMonth || 1) - 1);
  const hhmm = t.timeOfDay || 600;
  const minutes = Math.floor(hhmm / 100) * 60 + (hhmm % 100);
  return { day, minutes, season: t.season, dayOfMonth: t.dayOfMonth, hhmm };
}

function saveId() {
  try {
    const dirs = readdirSync(SAVES)
      .map((d) => join(SAVES, d))
      .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return dirs.length ? dirs[0].split(/[\\/]/).pop() : 'default';
  } catch {
    return 'default';
  }
}

function mapFile(location) {
  return join(SAVES, saveId(), 'pathmap', `${location}.json`);
}

function loadMap(location, clock) {
  const file = mapFile(location);
  if (!existsSync(file)) return { schema: 2, map: location, size: null, tiles: {} };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (raw.schema !== 2) throw new Error(`schema ${raw.schema} not supported`);
  raw.tiles = raw.tiles || {};
  if (clock) {
    let changed = 0;
    for (const [k, rec] of Object.entries(raw.tiles)) {
      const next = decayTile(rec, clock);
      if (next !== rec) { raw.tiles[k] = next; changed++; }
    }
    if (changed) {
      STATS.decayed = changed;
      saveMap(raw);
    }
  }
  return raw;
}

/** Merge-write: temp file then rename, so a crash never leaves half a map. */
function saveMap(map) {
  const file = mapFile(map.map);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(map), 'utf8');
  renameSync(tmp, file);
}

// ── tile records ───────────────────────────────────────────────────────────
/**
 * Apply a patch with the spec's source priority. Returns true when the record
 * actually changed (so callers can report "map learned something").
 */
function setTile(map, x, y, patch) {
  const k = key(x, y);
  const cur = map.tiles[k] || { state: 'unknown' };
  const curPrio = PRIORITY[cur.src] || 0;
  const newPrio = PRIORITY[patch.src] || 0;

  // A lower-priority source never overrides a fresh higher-priority one, unless
  // the higher one has been contradicted often enough (see noteContradiction).
  if (cur.state !== 'unknown' && newPrio < curPrio && !patch.force) return false;

  if (!map.tiles[k]) STATS.learned++;
  const next = { ...cur, ...patch };
  if (next.state === 'unknown') next.state = 'unknown';
  // never write zero-valued noise for walk tiles
  if (next.state === 'walk') next.cost = 0;
  map.tiles[k] = next;
  return true;
}

/**
 * A second contradiction for the same tile downgrades it to unknown, per spec:
 * nothing is permanently blocked, reality gets re-tested.
 */
function noteContradiction(map, x, y, observed, src, clock) {
  const k = key(x, y);
  const cur = map.tiles[k];
  if (!cur) return setTile(map, x, y, stamp({ state: observed, src, hits: 1, strikes: 1 }, clock));
  const sameAsBefore = (cur.state === observed);
  if (sameAsBefore) return false;
  const strikes = (cur.strikes || 0) + 1;
  // Third failed attempt = a real wall (until the TTL re-tests it). Without this
  // the spec's "two contradictions -> unknown" cycles block -> unknown -> probe
  // forever and the character grinds against the same tree.
  if (strikes >= 3) {
    map.tiles[k] = stamp({
      state: 'block', kind: 'object', need: 'walk_blocked', src, at: cur.at,
      strikes, hits: 0, ttlDays: 1,
    }, clock);
    return true;
  }
  if (strikes >= 2) {
    map.tiles[k] = { state: 'unknown', src, at: cur.at, hits: 0, strikes };
    return true;
  }
  map.tiles[k] = { ...cur, strikes, hits: 1 };
  return true;
}

// ── look: classify a /surroundings tile ────────────────────────────────────
const CLEARABLE_OBJECTS = { Weeds: 'weed', Twig: 'twig', Stone: 'stone', 'Stone (small)': 'stone' };
const BLOCK_OBJECTS = {
  'Twig': null,
};
const BLOCK_TERRAIN = new Set(['Tree', 'Bush', 'GiantCrop']);

function classify(tile) {
  // crops always block: never walk over them
  if (tile.crop) return { state: 'block', kind: 'crop' };
  // Resource clumps (weed clusters, boulders, stumps) block movement but are not
  // reported as passable=false -- only via `resource`. Treat them as walls so the
  // planner routes around instead of walking into them (seen stuck at 49,58).
  if (tile.resource) return { state: 'block', kind: 'clump' };
  if (tile.object) {
    const obj = tile.object;
    // Green rain (summer 1.6) spawns GreenRainWeeds4 / GreenRainWeeds7 / ... all
    // over the valley overnight; they are ordinary scythe weeds with a variant
    // name, not walls.
    const kind = CLEARABLE_OBJECTS[obj] || (/^GreenRainWeeds/i.test(obj) ? 'weed' : null);
    if (kind) return { state: 'clearable', kind };
    if (obj === 'Stone') return { state: 'clearable', kind: 'stone' };
    return { state: 'block', kind: 'object' };
  }
  if (tile.terrain === 'Tree') {
    // Trees are removable, just expensive (4s + 10 stamina per the price list),
    // so they are clearable rather than walls.
    return { state: 'clearable', kind: 'tree' };
  }
  if (tile.terrain && BLOCK_TERRAIN.has(tile.terrain)) {
    return { state: 'block', kind: 'object' };
  }
  if (tile.passable === false) {
    return { state: 'block', kind: tile.water ? 'water' : 'wall' };
  }
  return { state: 'walk', kind: null };
}

function clearSpecFor(kind, inventory) {
  const spec = CLEAR_TABLE[kind];
  if (!spec) return { ok: false, reason: `no_clear_rule_for_${kind}` };
  if (inventory && !inventory[spec.tool]) {
    return { ok: false, reason: `missing_tool_${spec.tool}` };
  }
  return { ok: true, spec };
}

// ── sources ────────────────────────────────────────────────────────────────
async function scan(map, state, radius) {
  const surr = await api(`/surroundings?radius=${radius}`);
  if (!surr.ok) throw new Error('surroundings failed: ' + JSON.stringify(surr).slice(0, 200));
  const inv = await inventoryByName();
  const clock = clockOf(state);
  // size must be the MAP size (from /map), not the scan window: the planner
  // uses it for bounds, and a 21x21 "size" would make every far tile out of
  // bounds.
  const mi = await api('/map');
  if (mi && mi.ok && mi.location) map.size = [mi.location.width, mi.location.height];
  if (mi && mi.ok && Array.isArray(mi.warps)) {
    map.warps = mi.warps.map((w) => ({ x: w.x, y: w.y, to: w.targetLocation, tx: w.targetX, ty: w.targetY }));
  }
  else map.size = [surr.scanned.x2 - surr.scanned.x1 + 1, surr.scanned.y2 - surr.scanned.y1 + 1];
  const r = applySurroundings(map, surr, inv, clock);
  return { ...r, tiles: surr.tiles.length, scanned: surr.scanned, npcs: surr.npcs || [] };
}

/**
 * Fold one /surroundings payload into the map. Shared by the full `scan` and the
 * cheap `refreshAround` used while walking (17 ms, no /map call).
 */
function applySurroundings(map, surr, inv, clock) {
  let changed = 0;
  let clearable = 0;
  for (const t of surr.tiles) {
    // Warp tiles live on the map edge (x == width / y == height) and the game
    // reports them as impassable; recording that made cross-map targets look
    // walled off. They are always enterable.
    if ((map.warps || []).some((w) => w.x === t.x && w.y === t.y)) {
      if (setTile(map, t.x, t.y, stamp({ state: 'walk', kind: undefined, cost: 0, src: 'look', at: clock.hhmm }, clock))) changed++;
      continue;
    }
    const c = classify(t);
    let patch = stamp({ state: c.state, kind: c.kind || undefined, src: 'look', at: clock.hhmm }, clock);
    if (c.state === 'clearable') {
      const spec = clearSpecFor(c.kind, inv);
      if (!spec.ok) {
        // no tool -> it is a wall as far as planning is concerned
        patch = stamp({ state: 'block', kind: c.kind, src: 'look', need: spec.reason, at: clock.hhmm }, clock);
      } else {
        patch.cost = spec.spec.cost;
        patch.need = { tool: spec.spec.tool, stamina: spec.spec.stamina, hits: spec.spec.hits };
        clearable++;
      }
    }
    if (!patch.kind) delete patch.kind;
    if (setTile(map, t.x, t.y, patch)) changed++;
  }
  // /surroundings only reports tiles that carry data (terrain feature, object,
  // blocked edge). A plain paved tile is simply absent. Treating those as
  // unknown made every town step a 2-second "probe"; they are plain ground.
  let filled = 0;
  const seen = new Set(surr.tiles.map((t) => key(t.x, t.y)));
  for (let y = surr.scanned.y1; y <= surr.scanned.y2; y++) {
    for (let x = surr.scanned.x1; x <= surr.scanned.x2; x++) {
      if (seen.has(key(x, y))) continue;
      if (map.size && (x < 0 || y < 0 || x >= map.size[0] || y >= map.size[1])) continue;
      const cur = map.tiles[key(x, y)];
      if (cur && cur.state === 'block') continue;   // never overwrite a known wall
      if (setTile(map, x, y, stamp({ state: 'walk', kind: undefined, cost: 0, src: 'look', at: clock.hhmm }, clock))) { changed++; filled++; }
    }
  }
  return { changed, filled, clearable };
}

/**
 * "Look before you move": re-read the tiles around the player. Cheap enough to
 * call at the start of every leg and every ~10 tiles.
 */
async function refreshAround(map, st, radius, inv) {
  const surr = await api(`/surroundings?radius=${radius}`);
  if (!surr.ok) return { changed: 0 };
  const clock = clockOf(st);
  const bag = inv || await inventoryByName();
  return applySurroundings(map, surr, bag, clock);
}

async function inventoryByName() {
  const inv = await api('/inventory');
  const out = {};
  for (const it of inv.items || []) out[it.name] = it;
  return out;
}

// ── pathfinding ────────────────────────────────────────────────────────────
/**
 * Dijkstra over the tile map.
 *   walk       0.2 s
 *   clearable  cost + 0.3 s
 *   block      impassable
 *   unknown    0.2 s + 2 s probe penalty
 * Diagonals are only allowed when BOTH orthogonal neighbours are walkable, so
 * the character never clips a corner.
 */
function plan(map, from, to) {
  // Accept both {x,y} and [x,y]: main() parsed the CLI arg into an array while
  // plan() read to.x/to.y, which silently produced the key "undefined,undefined"
  // and made every route look unreachable.
  const goal = Array.isArray(to) ? { x: to[0], y: to[1] } : to;
  from = Array.isArray(from) ? { x: from[0], y: from[1] } : from;
  to = goal;
  const size = map.size;
  const inBounds = (x, y) => (size ? x >= 0 && y >= 0 && x < size[0] && y < size[1] : true);
  const tileAt = (x, y) => map.tiles[key(x, y)] || { state: 'unknown' };
  const walkableState = (t) => t.state === 'walk' || t.state === 'clearable' || t.state === 'unknown';
  // Warp tiles sit on the map edge (x == width) and are therefore outside the
  // bounds check; they are legitimate destinations, so let them through.
  // They are also always enterable: a warp tile recorded as "block" (the look
  // scan used to write the out-of-bounds edge as impassable) would otherwise
  // make every cross-map route look unreachable.
  const warpKeys = new Set((map.warps || []).map((w) => key(w.x, w.y)));

  const dist = new Map();
  const prev = new Map();
  const startK = key(from.x, from.y);
  dist.set(startK, 0);
  // simple binary-heap-free priority queue: maps are small enough
  const pq = [{ x: from.x, y: from.y, d: 0 }];
  let best = { x: from.x, y: from.y, d: 0 };
  const goalK = key(to.x, to.y);

  let popped = 0;
  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const cur = pq.shift();
    const ck = key(cur.x, cur.y);
    popped++;
    if (cur.d > (dist.get(ck) ?? Infinity)) continue;
    if (ck === goalK) { best = cur; break; }
    if (cur.d < best.d || best.x === from.x && best.y === from.y) best = cur;

    const steps = [
      [0, -1, 1], [0, 1, 1], [-1, 0, 1], [1, 0, 1],
    ];
    for (const [dx, dy, scale] of steps) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!inBounds(nx, ny) && !warpKeys.has(key(nx, ny))) continue;
      const nk = key(nx, ny);
      const t = tileAt(nx, ny);
      if (!walkableState(t) && !warpKeys.has(nk)) continue;
      const nd = cur.d + (warpKeys.has(nk) ? TILE_SECONDS : stepCost(t)) * scale;
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, ck);
        pq.push({ x: nx, y: ny, d: nd });
      }
    }
  }

  if (process.env.PATHMAP_DEBUG) console.error('debug: popped', popped, 'dist', dist.size, 'pq', pq.length, 'goalK', goalK, 'has', dist.has(goalK));
  const reachedGoal = dist.has(goalK);
  const endK = reachedGoal ? goalK : key(best.x, best.y);
  if (endK === startK) {
    const t = tileAt(to.x, to.y);
    return { error: 'unreachable', reason: reasonFor(t), nearest: [from.x, from.y], cost: 0, steps: [] };
  }
  const path = [];
  let k = endK;
  while (k && k !== startK) { path.push(parseXY(k)); k = prev.get(k); }
  path.reverse();
  const steps = path.map(([x, y]) => {
    const t = tileAt(x, y);
    return { x, y, state: t.state, action: t.state === 'walk' ? 'walk' : t.state === 'clearable' ? 'clear' : 'probe', cost: stepCost(t) };
  });
  return {
    ok: reachedGoal,
    cost: dist.get(endK) ?? 0,
    steps,
    nearest: reachedGoal ? null : [best.x, best.y],
    reason: reachedGoal ? null : reasonFor(tileAt(to.x, to.y)),
  };
}

function stepCost(t) {
  if (t.state === 'walk') return TILE_SECONDS;
  if (t.state === 'clearable') return (t.cost || 0.5) + CLEAR_EXTRA;
  if (t.state === 'unknown') return TILE_SECONDS + UNKNOWN_PROBE_PENALTY;
  return Infinity;
}

function reasonFor(t) {
  if (t.state === 'block') return t.kind === 'water' ? 'water' : t.need && String(t.need).startsWith('missing_tool') ? 'missing_tool' : 'wall';
  return 'unreachable';
}

function findWarp(map, destName) {
  const want = String(destName || '').toLowerCase();
  const exact = (map.warps || []).filter((w) => String(w.to || '').toLowerCase() === want);
  const pool = exact.length ? exact : (map.warps || []).filter((w) => String(w.to || '').toLowerCase().includes(want));
  if (!pool.length) return null;
  // Several tiles of one doorway can be warps; pick one that is not recorded as
  // a wall, so the route does not depend on a stale "block" note.
  const open = pool.find((w) => { const t = map.tiles[key(w.x, w.y)]; return !t || t.state !== 'block'; });
  return open || pool[0];
}

/** Wait until the character stops moving (SDV reports player.isMoving). */
async function settle(maxMs = 900) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < maxMs) {
    try {
      const st = await getState();
      last = st;
      if (!st.player.isMoving) return st;
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 60));
  }
  return last;
}

// ── walking ────────────────────────────────────────────────────────────────
function startKeyer() {
  const proc = spawn(psExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'keyer.ps1')], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  let buf = '';
  const waiters = [];
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  let closed = false;
  function send(line) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error('keyer closed'));
      const timer = setTimeout(() => reject(new Error('keyer timeout')), 15000);
      waiters.push((l) => {
        clearTimeout(timer);
        if (l.startsWith('ok')) resolve(l); else reject(new Error(l));
      });
      proc.stdin.write(line + '\n');
    });
  }
  return {
    tap(hwnd, k, holdMs) { return send(`${hwnd} ${k} ${holdMs}`); },
    down(hwnd, k) { return send(`${hwnd} ${k} down`); },
    up(hwnd, k) { return send(`${hwnd} ${k} up`); },
    close() {
      if (closed) return;
      closed = true;
      try { proc.stdin.write('quit\n'); } catch { /* ignore */ }
      setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 300);
    },
  };
}

const DIRS = [
  { k: 'w', dx: 0, dy: -1 },
  { k: 's', dx: 0, dy: 1 },
  { k: 'a', dx: -1, dy: 0 },
  { k: 'd', dx: 1, dy: 0 },
];

function dirOf(from, to) {
  for (const d of DIRS) if (from.x + d.dx === to.x && from.y + d.dy === to.y) return d.k;
  return null;
}

async function clearTile(hwnd, keyer, map, x, y, holdMs) {
  const st = await getState();
  const now = { x: st.player.x, y: st.player.y };
  const dir = dirOf({ x, y }, now) || DIRS.find((d) => now.x + d.dx === x && now.y + d.dy === y)?.k;
  const approach = DIRS.find((d) => now.x + d.dx === x && now.y + d.dy === y);
  if (!approach) return { ok: false, reason: 'not_adjacent' };

  const tile = (await api(`/surroundings?radius=2`)).tiles.find((t) => t.x === x && t.y === y) || {};
  const c = classify(tile);
  const inv = await inventoryByName();
  const spec = clearSpecFor(c.kind, inv);
  if (!spec.ok) return { ok: false, reason: spec.reason };

  // face the tile, then select the tool, then swing
  await keyer.tap(hwnd, approach.k, 90);
  await new Promise((r) => setTimeout(r, 120));
  const slot = Object.values(inv).find((it) => it.name === spec.spec.tool);
  if (slot && typeof slot.slotIndex === 'number' && slot.slotIndex < 10) {
    await keyer.tap(hwnd, String(slot.slotIndex + 1), 90);
    await new Promise((r) => setTimeout(r, 150));
  }
  // Swing until the tile stops being clearable, not a fixed count: a full tree
  // needs more hits than the price list implies and a stump needs two more.
  const maxHits = Math.max(spec.spec.hits, 12);
  let swings = 0;
  for (let hit = 0; hit < maxHits; hit++) {
    await keyer.tap(hwnd, 'c', holdMs);
    swings++;
    await new Promise((r) => setTimeout(r, 520));
    const again = (await api(`/surroundings?radius=2`)).tiles.find((t) => t.x === x && t.y === y);
    if (!again || classify(again).state !== 'clearable') break;
  }
  const clock = clockOf(await getState());
  const after = (await api(`/surroundings?radius=2`)).tiles.find((t) => t.x === x && t.y === y);
  const stillThere = after && classify(after).state === 'clearable';
  if (!stillThere) {
    // `cleared` remembers what used to be here: a weed/twig tile is expected to
    // regrow after TTL_DAYS and decays back to clearable (see decayTile).
    setTile(map, x, y, stamp({
      state: 'walk', kind: undefined, cost: 0, src: 'event', at: clock.hhmm, hits: 0,
      cleared: c.kind, ttlDays: TTL_DAYS.event,
    }, clock));
    saveMap(map);
  }
  return { ok: !stillThere, reason: stillThere ? 'still_clearable_after_max_hits' : undefined, kind: c.kind, tool: spec.spec.tool, swings };
}

/**
 * Hold one direction key and poll until the segment end.
 * This is the whole speed story: a tap+settle costs ~1.5 s per tile, while a
 * held key covers ~5 tiles/s -- the character walks at the same speed a human
 * does, instead of 7x slower in game time.
 */
async function runSegment(keyer, hwnd, dir, target, maxMs) {
  const t0 = Date.now();
  let last = null;
  let still = 0;
  let st = null;
  let reason = 'timeout';
  await keyer.down(hwnd, dir);
  try {
    while (Date.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, 60));
      try { st = await getState(); } catch { continue; }
      if (st.activeMenu || st.activeEvent || st.in_dialogue) { reason = 'overlay'; break; }
      const pos = { x: st.player.x, y: st.player.y };
      if (pos.x === target.x && pos.y === target.y) { reason = 'target'; break; }
      if (last && pos.x === last.x && pos.y === last.y) still++; else still = 0;
      // Ignore the first ~300 ms: the game needs a beat to start moving.
      if (still >= 3 && Date.now() - t0 > 320) { reason = 'stuck'; break; }
      last = pos;
    }
  } finally {
    try { await keyer.up(hwnd, dir); } catch { /* keyer died */ }
  }
  // The walk animation runs a couple of frames past KEYUP.
  const settled = await settle(500);
  if (settled) st = settled;
  return { st, pos: st ? { x: st.player.x, y: st.player.y } : last, reason };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function argOf(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}

/**
 * Resolve the target window. A hand-typed hex handle is the single most
 * expensive typo in this project (2f04c0 vs 2f0480 posts into the void and looks
 * exactly like "the game is frozen"). So: when no handle is given, ask
 * gethwnd.ps1 for the modded instance's window.
 */
function resolveHwnd(hint) {
  if (hint && hint !== 'auto') return hint;
  const out = execFileSync(psExe(), [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'gethwnd.ps1'),
  ], { encoding: 'utf8' }).trim();
  if (!out) throw new Error('no modded Stardew window found');
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'scan') {
    const radius = Number(argOf(argv, '--radius', 20));
    const st = await getState();
    const loc = st.location.name;
    const map = loadMap(loc, clockOf(st));
    const r = await scan(map, st, radius);
    saveMap(map);
    console.log(JSON.stringify({ ok: true, map: loc, ...r, tilesKnown: Object.keys(map.tiles).length, file: mapFile(loc) }));
    return;
  }

  if (cmd === 'plan') {
    const st = await getState();
    const loc = st.location.name;
    const map = loadMap(loc, clockOf(st));
    const to = parseXY(argOf(argv, '--to'));
    const fromArg = argOf(argv, '--from');
    const from = fromArg ? { x: parseXY(fromArg)[0], y: parseXY(fromArg)[1] } : { x: st.player.x, y: st.player.y };
    const p = plan(map, from, to);
    console.log(JSON.stringify({ map: loc, from, to, ...p, file: mapFile(loc) }));
    return;
  }

  if (cmd === 'go') {
    const hwnd = resolveHwnd(argOf(argv, '--hwnd', process.env.STARDEW_HWND));
    const hold = Number(argOf(argv, '--hold', 200));
    const budget0 = Number(argOf(argv, '--max', 200));
    const via = String(argOf(argv, '--via', '') || '').split(',').map((v) => v.trim()).filter(Boolean);
    const toArg = argOf(argv, '--to');
    const target = toArg ? (() => { const [x, y] = parseXY(toArg); return { x, y }; })() : null;
    const keyer = startKeyer();
    const trace = [];
    const bumpCap = Number(argOf(argv, '--bumps', 40));
    let budget = budget0;
    let bumps = 0;
    // Per-tile failure counter for "the oracle says walk, the body says no".
    // Mailboxes, chests, pets and other objects the surroundings scan does not
    // report all land here; three strikes and we trust the feet, not the API.
    const walkFails = new Map();
    let clearFails = 0;
    let stopReason = null;
    STATS.learned = 0;

    async function waitLocation(prev, ms = 12000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const s = await getState();
          if (s.location.name !== prev) return s.location.name;
        } catch { /* transient during load */ }
      }
      return prev;
    }

    /** Ask the game about one tile right now (radius-1 look as the oracle). */
    async function askTile(map, x, y) {
      try {
        const st = await getState();
        await refreshAround(map, st, 1);
        return (map.tiles[key(x, y)] || {}).state || 'unknown';
      } catch { return 'unknown'; }
    }

    /** Walk to a tile in the CURRENT map; returns a stop reason. */
    async function walkTo(t) {
      let st = await getState();
      const map = loadMap(st.location.name, clockOf(st));
      // If we are standing on a tile the map calls a wall (an earlier tap failed
      // three times for unrelated reasons), trust the feet -- otherwise a false
      // wall at a doorway can seal the route to it forever.
      const hereK = key(st.player.x, st.player.y);
      // Feet are truth, with priority: the tile we stand on is walkable no
      // matter what a look scan claims (porch/door tiles are reported
      // passable=false even though you can stand and walk on them).
      setTile(map, st.player.x, st.player.y, stamp({ state: 'walk', cost: 0, kind: undefined, src: 'event', at: clockOf(st).hhmm }, clockOf(st)));
      let route = null;
      let ri = 0;
      // New day: the wake-up animation swallows input, so stand still for 5 s
      // instead of burning a keystroke on it (user's rule, 2026-11-07).
      if (st.player.isInBed) {
        for (let i = 0; i < 2 && st.player.isInBed; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          st = await getState();
        }
        trace.push({ action: 'wake', inBed: st.player.isInBed, pos: [st.player.x, st.player.y] });
      }
      // "Look before you move": refresh the neighbourhood at the start of a leg
      // and every ~10 tiles after that. A 21x21 look costs ~17 ms.
      let moved = 0;
      await refreshAround(map, st, 10);
      for (let i = 0; i < budget; i++) {
        budget--;
        st = await getState();
        // A warp can land between iterations (the game transitions after the
        // step completes). Using the old map here made the character look like
        // it was bumping into walls at coordinates from another map entirely.
        if (st.location.name !== map.map) {
          trace.push({ action: 'warp', from: map.map, to: st.location.name });
          return 'warped';
        }
        const cur = { x: st.player.x, y: st.player.y };
        if (cur.x === t.x && cur.y === t.y) return 'arrived';
        if (st.activeMenu || st.activeEvent || st.in_dialogue) return 'blocked_by_overlay';
        if (moved >= 10) { await refreshAround(map, st, 10); moved = 0; }
        // Plan once per route and follow it tile by tile; re-plan only when the
        // character deviates (bump, clear, warp) or the route runs out. A full
        // Dijkstra per single step was the last real CPU cost in the loop.
        if (!route) {
          const p = plan(map, cur, t);
          if (!p.steps || !p.steps.length) return p.error || 'no_path';
          // An unreachable goal used to be followed to its nearest tile, and the
          // next iteration planned back to the tile just left: a two-tile loop
          // that burned the whole step budget (seen on Farm -> BusStop). Report
          // it instead; the nearest tile is in the trace.
          if (p.ok === false) return `unreachable:${p.reason || 'unknown'}:${(p.nearest || []).join(',')}`;
          route = p.steps;
          ri = 0;
        }
        if (ri >= route.length) { route = null; continue; }
        const next = route[ri];
        // The route only means something while we stand on the tile before it.
        if (Math.abs(next.x - cur.x) + Math.abs(next.y - cur.y) !== 1) { route = null; continue; }
        if (next.action === 'clear') {
          const r = await clearTile(hwnd, keyer, map, next.x, next.y, hold);
          trace.push({ tile: [next.x, next.y], action: 'clear', ...r });
          if (!r.ok) {
            route = null;
            if (++clearFails > 8) return 'clear_failed:' + (r.reason || 'unknown');
            // A tree/stump/boulder can refuse the tool. Treat it as a wall so
            // the next plan goes around instead of swinging at it again forever;
            // decayTile re-tests it after TTL_DAYS.
            const clock = clockOf(await getState());
            setTile(map, next.x, next.y, stamp({
              state: 'block', kind: r.kind || 'object', need: 'clear_failed',
              src: 'event', at: clock.hhmm, ttlDays: TTL_DAYS.event,
            }, clock));
            saveMap(map);
            continue;
          }
          ri++;
          continue;
        }
        const dir = dirOf(cur, next);
        // Batch a straight run of plain-walk steps into ONE held key press.
        let k = 1;
        while (ri + k < route.length && k < 14) {
          const a = route[ri + k - 1], b = route[ri + k];
          if (b.action !== 'walk' || b.state !== 'walk') break;
          if (dirOf(a, b) !== dir) break;
          k++;
        }
        const segEnd = route[ri + k - 1];

        if (k >= 2 && dir) {
          budget -= (k - 1);
          const r = await runSegment(keyer, hwnd, dir, segEnd, 600 + k * 400);
          const after = r.st;
          const now = r.pos || cur;
          trace.push({ run: k, dir, want: [segEnd.x, segEnd.y], got: [now.x, now.y], how: r.reason });
          if (!after) return 'state_lost';
          if (after.location.name !== st.location.name) {
            trace.push({ action: 'warp', from: st.location.name, to: after.location.name });
            return 'warped';
          }
          if (r.reason === 'overlay') return 'blocked_by_overlay';
          if (now.x === segEnd.x && now.y === segEnd.y) {
            // Feet are truth: a tile we actually walked onto stays walkable and
            // outranks any look scan (porch/door tiles are reported impassable).
            setTile(map, now.x, now.y, stamp({ state: 'walk', cost: 0, kind: undefined, src: 'event', at: clockOf(st).hhmm }, clockOf(st)));
            ri += k; moved += k; continue;
          }
          route = null;   // partial run: the route no longer matches where we are
          if (r.reason === 'stuck') {
            // A swallowed first keydown looks exactly like a wall. One retry,
            // the way a human would just press again.
            await keyer.tap(hwnd, dir, hold);
            const again = await settle() || await getState();
            const p2 = { x: again.player.x, y: again.player.y };
            if (p2.x !== now.x || p2.y !== now.y) {
              trace.push({ retry: true, from: [now.x, now.y], got: [p2.x, p2.y] });
              continue;
            }
            const bx = now.x + Math.sign(segEnd.x - now.x);
            const by = now.y + Math.sign(segEnd.y - now.y);
            const live = await askTile(map, bx, by);
            if (live === 'walk' || live === 'clearable') {
              // The game itself says the tile is passable: a swallowed key or a
              // timing problem, not a wall. Count a bump, keep the tile.
              bumps++;
              trace.push({ tile: [bx, by], action: 'walk', ok: false, oracle: live });
              const wkey = bx + ',' + by;
              const fails = (walkFails.get(wkey) || 0) + 1;
              walkFails.set(wkey, fails);
              if (fails >= 3) {
                // Three attempts, no movement, and the surroundings scan still
                // calls it walkable: something invisible to the scan sits there
                // (mailbox, chest, animal). Believe the body and re-route.
                setTile(map, bx, by, stamp({
                  state: 'block',
                  cost: Infinity,
                  need: 'walk_blocked',
                  src: 'event',
                  at: clockOf(st).hhmm,
                  ttlDays: 1,
                }, clockOf(st)));
                saveMap(map);
                walkFails.delete(wkey);
                route = null;
                trace.push({ tile: [bx, by], action: 'blocked_by_body', need: 'walk_blocked' });
              }
              if (bumps >= bumpCap) return 'too_many_bumps';
              continue;
            }
            noteContradiction(map, bx, by, 'block', 'walk', clockOf(st));
            saveMap(map);
            bumps++;
            trace.push({ tile: [bx, by], action: 'walk', ok: false, got: [now.x, now.y] });
            if (bumps >= bumpCap) return 'too_many_bumps';
          }
          continue;
        }

        await keyer.tap(hwnd, dir, hold);
        // Polling beats a fixed sleep: tapping faster than the walk animation
        // produced phantom "blocked" results (same tile failed, then succeeded).
        let after = await settle() || await getState();
        let now = { x: after.player.x, y: after.player.y };
        // A dropped keystroke looks exactly like a wall. A human would just
        // press again, so do the same before writing off the tile.
        if (now.x === cur.x && now.y === cur.y && after.location.name === st.location.name) {
          await keyer.tap(hwnd, dir, hold);
          after = await settle() || await getState();
          now = { x: after.player.x, y: after.player.y };
        }
        if (after.location.name !== st.location.name) {
          trace.push({ action: 'warp', from: st.location.name, to: after.location.name });
          return 'warped';
        }
        if (now.x === next.x && now.y === next.y) {
          if (next.action === 'probe') {
            setTile(map, now.x, now.y, { state: 'walk', src: 'walk', cost: 0, kind: undefined });
            saveMap(map);
          }
          setTile(map, now.x, now.y, stamp({ state: 'walk', cost: 0, kind: undefined, src: 'event', at: clockOf(st).hhmm }, clockOf(st)));
          ri++;
          moved++;
          trace.push({ tile: [now.x, now.y], action: next.action, ok: true });
        } else {
          route = null;
          const live = await askTile(map, next.x, next.y);
          if (live === 'walk' || live === 'clearable') {
            bumps++;
            trace.push({ tile: [next.x, next.y], action: next.action, ok: false, oracle: live, got: [now.x, now.y] });
            if (bumps >= bumpCap) return 'too_many_bumps';
            continue;
          }
          noteContradiction(map, next.x, next.y, 'block', 'walk', clockOf(st));
          saveMap(map);
          bumps++;
          trace.push({ tile: [next.x, next.y], action: next.action, ok: false, got: [now.x, now.y] });
          if (bumps >= bumpCap) return 'too_many_bumps';
        }
      }
      return 'budget';
    }

    try {
      const wall0 = Date.now();
      const st0 = await getState();
      const startClock = clockOf(st0);
      const startLoc = st0.location.name;

      for (const dest of via) {
        const st = await getState();
        if (st.location.name.toLowerCase() === dest.toLowerCase()) continue;
        const map = loadMap(st.location.name, clockOf(st));
        const w = findWarp(map, dest);
        if (!w) { stopReason = 'no_warp_to:' + dest; break; }
        const r1 = await walkTo({ x: w.x, y: w.y });
        if (r1 !== 'arrived' && r1 !== 'warped') { stopReason = r1; break; }
        const landed = await waitLocation(st.location.name);
        trace.push({ action: 'hop', from: st.location.name, to: landed, want: dest });
        if (landed.toLowerCase() !== dest.toLowerCase()) { stopReason = 'landed_in:' + landed; break; }
      }

      if (!stopReason && target) stopReason = await walkTo(target);

      const stEnd = await getState();
      const endClock = clockOf(stEnd);
      const gameMinutes = (endClock.day - startClock.day) * 1440
        + (endClock.minutes - startClock.minutes);
      console.log(JSON.stringify({
        ok: target ? (stEnd.player.x === target.x && stEnd.player.y === target.y) : true,
        startMap: startLoc,
        endMap: stEnd.location.name,
        from: [st0.player.x, st0.player.y],
        to: [stEnd.player.x, stEnd.player.y],
        target,
        stopReason,
        bumps,
        clearFails,
        learned: STATS.learned,
        steps: trace.length,
        wallSec: Math.round((Date.now() - wall0) / 100) / 10,
        gameMin: gameMinutes,
        secPerTile: trace.length ? Math.round((Date.now() - wall0) / 100 / trace.length) / 10 : null,
        trace: trace.slice(-14),
        file: mapFile(stEnd.location.name),
      }));
    } finally {
      keyer.close();
    }
    return;
  }

  if (cmd === 'clear') {
    const hwnd = resolveHwnd(argOf(argv, '--hwnd', process.env.STARDEW_HWND));
    const hold = Number(argOf(argv, '--hold', 200));
    const [x, y] = parseXY(argOf(argv, '--at'));
    const st = await getState();
    const map = loadMap(st.location.name, clockOf(st));
    const keyer = startKeyer();
    try {
      const r = await clearTile(hwnd, keyer, map, x, y, hold);
      console.log(JSON.stringify({ ok: r.ok, ...r, tile: map.tiles[key(x, y)] }));
    } finally {
      keyer.close();
    }
    return;
  }

  if (cmd === 'info') {
    const st = await getState();
    const loc = st.location.name;
    const map = loadMap(loc, clockOf(st));
    const counts = { walk: 0, block: 0, clearable: 0, unknown: 0 };
    for (const t of Object.values(map.tiles)) counts[t.state] = (counts[t.state] || 0) + 1;
    console.log(JSON.stringify({ map: loc, size: map.size, counts, file: mapFile(loc), player: [st.player.x, st.player.y] }));
    return;
  }

  console.error(`unknown command: ${cmd}`);
  console.error('usage: scan | plan --to x,y | go --to x,y --hwnd HEX | clear --at x,y --hwnd HEX | info');
  process.exit(2);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  process.exit(1);
});

