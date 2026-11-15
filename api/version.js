'use strict';
// GET /api/version -> { version, build, at, note, history, auto }
//
// Automatic versioning that NEVER goes down and never disappears. The base (MAJOR.MINOR) is set in
// version.json. The PATCH number goes up by one on EVERY production deployment, forever, and is
// stored in Firestore (meta/version) so every server instance agrees. Nothing to edit by hand.
//   - The patch never restarts: changing "base" (for example "2.5") keeps counting (2.4.9 -> 2.5.10).
//   - "build" in version.json is a floor: the patch is always at least that number, so the version is
//     right even if Firestore is empty or not connected yet (then the page shows BASE.BUILD).
//   - Optional env RELEASE_NOTE: the note shown for the release. RELEASE_NOTES_FROM_GIT=1 uses the git
//     commit message instead (it becomes public, so leave it off if your commits are private).
//   - Preview deployments never change the number.
const base = require('../version.json');
const { getDb, send } = require('./_admin');

const BASE = String(base.base || '1.0');
const FLOOR = Math.max(0, parseInt(base.build, 10) || 0);
const FILE_AT = Date.parse(base.releasedAt || base.released || '') || 0; // when this version was made (from version.json)
const buildId = () => (process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_URL || 'local').trim();
const isProd = () => !process.env.VERCEL_ENV || process.env.VERCEL_ENV === 'production';
const note = () => {
  const fromGit = process.env.RELEASE_NOTES_FROM_GIT === '1' ? String(process.env.VERCEL_GIT_COMMIT_MESSAGE || '').split('\n')[0] : '';
  return ((process.env.RELEASE_NOTE || '').trim() || fromGit.trim() || 'Improvements and fixes').slice(0, 140);
};

// Release log shipped with the app (version.json), so the history is always complete. Entries saved in Firestore
// (one per deployment, with the real deploy time) win over the built-in entry of the same version.
const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
const BUILTIN = (Array.isArray(base.releases) ? base.releases : []).map((r) => ({ version: String(r.version), at: Date.parse(r.at) || 0, note: String(r.note || '') })).filter((r) => r.version && r.at);
function merged(history) {
  const seen = new Set();
  return (Array.isArray(history) ? history : []).concat(BUILTIN).filter((h) => h && h.version && !seen.has(h.version) && seen.add(h.version)).sort((a, b) => cmp(b.version, a.version)).slice(0, 60);
}

let cache = null; // per server instance

async function current() {
  if (cache) return cache;
  const id = buildId();
  const db = getDb();
  if (!db) return (cache = { version: BASE + '.' + FLOOR, build: id.slice(0, 8), at: FILE_AT, note: '', history: merged([]), auto: false });
  const ref = db.doc('meta/version');
  let d;
  if (isProd()) {
    d = await db.runTransaction(async (t) => {
      const s = await t.get(ref);
      const old = s.exists ? s.data() : null;
      if (old && old.buildId === id && old.base === BASE && (old.patch || 0) >= FLOOR) return old; // this deployment is already counted
      const patch = Math.max(old ? (old.patch || 0) + (old.buildId === id ? 0 : 1) : 0, FLOOR); // never goes down, never restarts
      const version = BASE + '.' + patch;
      const at = Date.now();
      const n = note();
      const history = [{ version, at, note: n }].concat(old && Array.isArray(old.history) ? old.history : []).slice(0, 200);
      const next = { base: BASE, patch, version, buildId: id, at, note: n, history };
      t.set(ref, next);
      return next;
    });
  } else {
    const s = await ref.get();
    d = s.exists ? s.data() : { version: BASE + '.' + FLOOR, at: FILE_AT, note: '', history: [] };
  }
  return (cache = { version: d.version, build: String(d.buildId || id).slice(0, 8), at: d.at || 0, note: d.note || '', history: merged(d.history), auto: true });
}

async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { error: 'Method not allowed' }); }
  try {
    const v = await current();
    res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
    return send(res, 200, v);
  } catch (e) {
    console.error('version failed:', e && e.message);
    res.setHeader('Cache-Control', 'no-store');
    return send(res, 200, { version: BASE + '.' + FLOOR, build: buildId().slice(0, 8), at: FILE_AT, note: '', history: merged([]), auto: false });
  }
}

module.exports = handler;
module.exports.current = current; // used by the Help assistant so it can tell the real version
module.exports.floorVersion = () => BASE + '.' + FLOOR;
module.exports.floorAt = () => FILE_AT;
