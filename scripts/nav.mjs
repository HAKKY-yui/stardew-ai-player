#!/usr/bin/env node
/**
 * nav.mjs -- walk to a tile using the recorded path map, learning as it goes.
 *
 * This is the other half of L2. walk.mjs records what it bumped into; nav.mjs
 * uses those records to pick a route, and when reality disagrees it writes the
 * correction back. The intended shape of the loop is:
 *
 *   plan from the map -> step one tile -> read the real position -> record what
 *   happened -> replan if reality differed
 *
 * A tile that has been recorded as blocked is never tried again, which is what
 * makes the second run of the same route cheaper than the first.
 *
 * Usage:
 *   node nav.mjs --hwnd 003801ba --to 50,60
 *   node nav.mjs --hwnd 003801ba --to 50,60 --map Town --max 60 --hold 200
 *
 * Output: one JSON line with the plan, the steps actually taken, how many were
 * replans, and the map file it wrote.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = (process.env.SDV_BRIDGE || 'http://localhost:7850') + '/state';
const MAPDIR = join(HERE, 'data', 'maps');

const DELTA = [
  { key: 'w', dx: 0, dy: -1 },
  { key: 's', dx: 0, dy: 1 },
  { key: 'a', dx: -1, dy: 0 },
  { key: 'd', dx: 1, dy: 0 },
];

function parseArgs(argv) {
  const out = { hold: 200, max: 40, map: null, hwnd: null, to: null, from: null, planOnly: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hwnd') out.hwnd = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--map') out.map = argv[++i];
    else if (a === '--hold') out.hold = Number(argv[++i]);
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--plan-only') out.planOnly = true;
    else if (a === '--verbose') out.verbose = true;
  }
  if (!out.hwnd && !out.planOnly) throw new Error('--hwnd is required');
  if (!out.to) throw new Error('--to x,y is required');
  return out;
}

async function getState() {
  const res = await fetch(API);
  const body = await res.json();
  if (!body.ok || !body.worldReady) throw new Error('world not ready: ' + JSON.stringify(body));
  return body;
}

function startKeyer() {
  const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'keyer.ps1')], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  let buf = '';
  const waiters = [];
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  let closed = false;
  function tap(hwnd, key, holdMs) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error('keyer closed'));
      const timer = setTimeout(() => reject(new Error('keyer timeout')), 15000);
      waiters.push((line) => {
        clearTimeout(timer);
        if (line.startsWith('ok')) resolve(line);
        else reject(new Error(line));
      });
      proc.stdin.write(`${hwnd} ${key} ${holdMs}\n`);
    });
  }
  function close() {
    if (closed) return;
    closed = true;
    try { proc.stdin.write('quit\n'); } catch { /* ignore */ }
    setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 300);
  }
  return { tap, close };
}

const keyOf = (x, y) => `${x},${y}`;

function loadMap(location) {
  const file = join(MAPDIR, `${location}.json`);
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* fall through */ }
  }
  return { location, version: 1, passable: {}, blocked: {}, updatedAt: null, samples: 0, routes: [] };
}

function saveMap(map) {
  mkdirSync(MAPDIR, { recursive: true });
  map.updatedAt = new Date().toISOString();
  writeFileSync(join(MAPDIR, `${map.location}.json`), JSON.stringify(map, null, 1), 'utf8');
}

/**
 * BFS over the known map. Unrecorded tiles are treated as passable (optimistic)
 * because the point of walking is to discover; recorded obstacles are avoided so
 * the second run does not repeat the same collision.
 */
function plan(map, from, to) {
  const start = keyOf(from.x, from.y);
  const goal = keyOf(to.x, to.y);
  const blocked = map.blocked || {};
  if (blocked[goal]) return { error: 'goal_recorded_blocked' };

  const queue = [{ x: from.x, y: from.y }];
  const seen = new Set([start]);
  const prev = new Map();
  const limit = 4000;

  while (queue.length && seen.size < limit) {
    const cur = queue.shift();
    if (cur.x === to.x && cur.y === to.y) {
      const path = [];
      let k = keyOf(cur.x, cur.y);
      while (prev.has(k)) {
        const p = prev.get(k);
        path.push(k);
        k = p;
      }
      path.reverse();
      return { path };
    }
    for (const d of DELTA) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      const nk = keyOf(nx, ny);
      if (seen.has(nk) || blocked[nk]) continue;
      seen.add(nk);
      prev.set(nk, keyOf(cur.x, cur.y));
      queue.push({ x: nx, y: ny });
    }
  }
  return { error: 'no_path' };
}

function dirBetween(a, b) {
  for (const d of DELTA) {
    if (a.x + d.dx === b.x && a.y + d.dy === b.y) return d;
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv);
  const [tx, ty] = opts.to.split(',').map(Number);
  const target = { x: tx, y: ty };
  if (opts.planOnly) {
    // Replay mode: no keyer, no walking. Answers "can the recorded map produce a
    // tile sequence for this pair of points" without touching the world.
    const st = await getState();
    const location = st.location.name;
    if (opts.map && location !== opts.map) throw new Error(`expected ${opts.map}, in ${location}`);
    const map = loadMap(location);
    const from = opts.from ? { x: Number(opts.from.split(',')[0]), y: Number(opts.from.split(',')[1]) }
                           : { x: st.player.x, y: st.player.y };
    const p = plan(map, from, { x: tx, y: ty });
    console.log(JSON.stringify({
      ok: !p.error, location, from, to: [tx, ty],
      tiles: p.path || [], tileCount: p.path ? p.path.length : 0, error: p.error || null,
      mapFile: join(MAPDIR, `${location}.json`),
    }));
    return;
  }

  const keyer = startKeyer();
  const steps = [];
  let replans = 0;
  let stopReason = null;
  let planned = null;

  try {
    let st = await getState();
    const location = st.location.name;
    if (opts.map && location !== opts.map) throw new Error(`expected ${opts.map}, in ${location}`);
    const map = loadMap(location);
    const startPos = { x: st.player.x, y: st.player.y };

    for (let i = 0; i < opts.max; i++) {
      const cur = { x: st.player.x, y: st.player.y };
      if (cur.x === target.x && cur.y === target.y) { stopReason = 'arrived'; break; }

      if (st.activeMenu || st.activeEvent || st.in_dialogue) {
        stopReason = 'blocked_by_overlay';
        break;
      }

      // Plan every step from the CURRENT position: cheap, and it means a wrong
      // assumption is corrected immediately instead of after a long detour.
      const p = plan(map, cur, target);
      if (p.error) { stopReason = p.error; break; }
      if (!planned) planned = p.path.slice();
      const nextKey = p.path[0];
      if (!nextKey) { stopReason = 'empty_plan'; break; }
      const [nx, ny] = nextKey.split(',').map(Number);
      const dir = dirBetween(cur, { x: nx, y: ny });
      if (!dir) { stopReason = 'bad_step'; break; }

      await keyer.tap(opts.hwnd, dir.key, opts.hold);
      await new Promise((r) => setTimeout(r, 110));
      st = await getState();
      const now = { x: st.player.x, y: st.player.y };

      if (now.x === cur.x && now.y === cur.y) {
        map.blocked[nextKey] = dir.key;
        delete map.passable[nextKey];
        replans++;
        saveMap(map);
        steps.push({ from: [cur.x, cur.y], dir: dir.key, verdict: 'blocked', tile: nextKey });
        if (replans >= 25) { stopReason = 'too_many_blocks'; break; }
      } else if (now.x === nx && now.y === ny) {
        map.passable[nextKey] = true;
        delete map.blocked[nextKey];
        steps.push({ from: [cur.x, cur.y], dir: dir.key, verdict: 'ok', to: [now.x, now.y] });
      } else {
        // Slid / warped / pushed somewhere unexpected: record and keep going from
        // wherever we actually are.
        map.passable[keyOf(now.x, now.y)] = true;
        steps.push({ from: [cur.x, cur.y], dir: dir.key, verdict: 'drift', to: [now.x, now.y] });
      }
    }

    if (!stopReason) stopReason = 'step_budget';

    const final = await getState();
    const finalPos = { x: final.player.x, y: final.player.y };
    map.samples = (map.samples || 0) + steps.length;
    if (finalPos.x === target.x && finalPos.y === target.y && planned) {
      map.routes = map.routes || [];
      map.routes.push({ from: startPos, to: target, tiles: planned.length, at: new Date().toISOString() });
      if (map.routes.length > 50) map.routes = map.routes.slice(-50);
    }
    saveMap(map);

    console.log(JSON.stringify({
      ok: finalPos.x === target.x && finalPos.y === target.y,
      location,
      from: startPos,
      to: actualTarget(finalPos),
      target,
      plannedTiles: planned ? planned.length : 0,
      stepsTaken: steps.length,
      replans,
      stopReason,
      mapFile: join(MAPDIR, `${location}.json`),
      passableTotal: Object.keys(map.passable || {}).length,
      blockedTotal: Object.keys(map.blocked || {}).length,
      steps,
    }));
  } finally {
    keyer.close();
  }
}

function actualTarget(pos) { return [pos.x, pos.y]; }

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  process.exit(1);
});
