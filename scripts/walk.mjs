#!/usr/bin/env node
/**
 * walk.mjs -- walk with real keystrokes, one tile at a time, and record what the
 * world allows.
 *
 * This is L2's proprioceptive half: the Mod tells us where the player IS, the
 * keystrokes are what actually move them, and every attempt is written down so a
 * later run does not have to rediscover the same walls.
 *
 * Contract per step:
 *   1. post <dir> for holdMs to the game window
 *   2. read /state
 *   3. position changed in the expected direction -> tile is passable
 *      position unchanged                              -> tile is blocked
 *      position changed in a different direction       -> recorded as drift (a
 *                                                        warp or a slide), and
 *                                                        the run stops
 *
 * Usage:
 *   node walk.mjs --hwnd 000c0130 --dir d --steps 5
 *   node walk.mjs --hwnd 000c0130 --dir s --steps 8 --hold 500 --map Farm
 *
 * Output: one JSON line per step, plus a summary. The map file is
 * data/maps/<Location>.json, merged into whatever was already recorded.
 */

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = (process.env.SDV_BRIDGE || 'http://localhost:7850') + '/state';
const MAPDIR = join(HERE, 'data', 'maps');

const DIRS = {
  w: { dx: 0, dy: -1, face: 0 },
  s: { dx: 0, dy: 1, face: 2 },
  a: { dx: -1, dy: 0, face: 3 },
  d: { dx: 1, dy: 0, face: 1 },
};

function parseArgs(argv) {
  const out = { dir: 'd', steps: 1, hold: 200, hwnd: null, map: null, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--steps') out.steps = Number(argv[++i]);
    else if (a === '--hold') out.hold = Number(argv[++i]);
    else if (a === '--hwnd') out.hwnd = argv[++i];
    else if (a === '--map') out.map = argv[++i];
    else if (a === '--verbose') out.verbose = true;
  }
  if (!out.hwnd) throw new Error('--hwnd is required');
  if (!DIRS[out.dir]) throw new Error(`--dir must be one of ${Object.keys(DIRS).join('/')}`);
  return out;
}

async function getState() {
  const res = await fetch(API);
  const body = await res.json();
  if (!body.ok || !body.worldReady) throw new Error('world not ready: ' + JSON.stringify(body));
  return body;
}

/** Start the persistent key poster and return {tap, close}. */
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
    try { proc.stdin.write('quit\n'); } catch { /* already gone */ }
    setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 300);
  }
  return { tap, close };
}

function loadMap(location) {
  const file = join(MAPDIR, `${location}.json`);
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* fall through */ }
  }
  return { location, version: 1, passable: {}, blocked: {}, updatedAt: null, samples: 0 };
}

function saveMap(map) {
  mkdirSync(MAPDIR, { recursive: true });
  map.updatedAt = new Date().toISOString();
  writeFileSync(join(MAPDIR, `${map.location}.json`), JSON.stringify(map, null, 1), 'utf8');
}

const key = (x, y) => `${x},${y}`;

async function main() {
  const opts = parseArgs(process.argv);
  const walk = DIRS[opts.dir];
  const keyer = startKeyer();
  const log = [];

  let map = null;
  let blockedCount = 0;
  let movedCount = 0;
  let stopReason = null;

  try {
    for (let i = 0; i < opts.steps; i++) {
      const before = await getState();
      const loc = before.location.name;
      if (opts.map && loc !== opts.map) throw new Error(`expected map ${opts.map}, in ${loc}`);
      if (!map || map.location !== loc) map = loadMap(loc);

      if (before.activeMenu || before.activeEvent || before.in_dialogue) {
        stopReason = `blocked by overlay: menu=${JSON.stringify(before.activeMenu)} dialogue=${before.in_dialogue}`;
        break;
      }

      const bx = before.player.x;
      const by = before.player.y;

      await keyer.tap(opts.hwnd, opts.dir, opts.hold);
      await new Promise((r) => setTimeout(r, 120));

      const after = await getState();
      const ax = after.player.x;
      const ay = after.player.y;
      const dx = ax - bx;
      const dy = ay - by;

      let verdict;
      if (dx === 0 && dy === 0) {
        verdict = 'blocked';
        blockedCount++;
        map.blocked[key(bx + walk.dx, by + walk.dy)] = opts.dir;
        delete map.passable[key(bx + walk.dx, by + walk.dy)];
        map.samples = (map.samples || 0) + 1;
        saveMap(map);
        log.push({ step: i + 1, from: [bx, by], to: [ax, ay], verdict });
        stopReason = `stopped at ${bx},${by}: ${opts.dir} is blocked`;
        break;
      }

      // Every tile between the two positions is walkable (a long hold can cross
      // more than one tile, so record the whole span).
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (dx !== 0 && dy !== 0 && steps > 1) {
        verdict = 'diagonal_drift';
        stopReason = `unexpected diagonal move ${bx},${by} -> ${ax},${ay}`;
      } else {
        verdict = dx === walk.dx * 0 || dx === 0 ? 'moved' : 'moved_off_axis';
        if (verdict === 'moved' || dx * walk.dx >= 0) verdict = 'moved';
      }

      const sx = Math.sign(dx);
      const sy = Math.sign(dy);
      for (let k = 1; k <= steps; k++) {
        const tx = bx + sx * k;
        const ty = by + sy * k;
        map.passable[key(tx, ty)] = true;
        delete map.blocked[key(tx, ty)];
      }
      map.samples = (map.samples || 0) + 1;
      saveMap(map);
      movedCount++;
      log.push({ step: i + 1, from: [bx, by], to: [ax, ay], verdict, tiles: steps });

      if (verdict !== 'moved') break;
    }

    const final = await getState();
    console.log(JSON.stringify({
      ok: true,
      location: final.location.name,
      from: log.length ? log[0].from : [final.player.x, final.player.y],
      to: [final.player.x, final.player.y],
      moved: movedCount,
      blocked: blockedCount,
      stopReason,
      mapFile: map ? join(MAPDIR, `${map.location}.json`) : null,
      passableTotal: map ? Object.keys(map.passable).length : 0,
      blockedTotal: map ? Object.keys(map.blocked).length : 0,
      steps: log,
    }));
  } finally {
    keyer.close();
  }
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  process.exit(1);
});
