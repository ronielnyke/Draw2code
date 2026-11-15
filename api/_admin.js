'use strict';

// Shared server helpers: Firestore (REST), auth check, plan lookup. See api/_firestore.js.
const { createDb, rememberToken } = require('./_firestore');

// Public Firebase web config of this project (these web keys are not secrets; access is
// protected by Firebase Auth + Firestore rules). Vercel env variables, if set, override them.
const FIREBASE_DEFAULTS = {
  FIREBASE_API_KEY: 'AIzaSyDO0WT9GJBbW01AIVCgACglvaN0g3U4WsA',
  FIREBASE_AUTH_DOMAIN: 'raw2code.firebaseapp.com',
  FIREBASE_PROJECT_ID: 'raw2code',
  FIREBASE_APP_ID: '1:246249703811:web:4141fdbe17139407138eb6',
  FIREBASE_MESSAGING_SENDER_ID: '246249703811',
  FIREBASE_STORAGE_BUCKET: 'raw2code.firebasestorage.app',
};
// Site address, sent as the Referer of server-side Firebase calls so they keep working when the web API key is
// restricted to this website (Google Cloud Console, Credentials). Override with PUBLIC_URL.
const SITE_URL = () => (process.env.PUBLIC_URL || 'https://draw2code-ai.vercel.app').trim().replace(/\/$/, '') + '/';
const fbEnv = (name) => (process.env[name] || FIREBASE_DEFAULTS[name] || '').trim();

let _db = null;

function getDb() {
  if (!_db) _db = createDb({ projectId: fbEnv('FIREBASE_PROJECT_ID'), apiKey: fbEnv('FIREBASE_API_KEY'), referer: SITE_URL() });
  return _db;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function verifyToken(idToken) {
  const key = fbEnv('FIREBASE_API_KEY');
  if (!key || !idToken) return null;
  try {
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: SITE_URL() },
      body: JSON.stringify({ idToken }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const u = j && j.users && j.users[0];
    if (!(u && u.localId)) return null;
    rememberToken(u.localId, idToken); // lets the server read/write this user's own Firestore records
    return { uid: u.localId, email: u.email || '', emailVerified: !!u.emailVerified };
  } catch (e) {
    return null;
  }
}

function bearer(req) {
  const a = String(req.headers.authorization || '');
  return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
}

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { return null; }
  }
  return b && typeof b === 'object' ? b : null;
}

// ---------------------------------------------------------------- Owner
// The verified owner has unlimited app-level access and does not need a paid plan.
// Identified ONLY by a Firebase-VERIFIED email (Google sign-in verifies it), so nobody can
// become owner by registering that email address with a password they chose.
// Override with env OWNER_EMAIL (comma-separated for more than one owner).
const OWNER_EMAILS = () => (process.env.OWNER_EMAIL || 'ronielnyke@gmail.com').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const isOwner = (user) => !!(user && user.emailVerified && user.email && OWNER_EMAILS().includes(String(user.email).toLowerCase()));

// ---------------------------------------------------------------- Pricing
// Paid  : 3 tiers, each monthly (30 days) or yearly (365 days). Amounts are in PHP.
// Generations come back 24 hours after the moment they were ALL used up (WINDOW_MS).
const WINDOW_MS = 24 * 3600 * 1000;
const BASIC_QUALITY = 'basic'; // retained for compatibility with existing quality helpers
const TIERS = () => ({
  starter:  { label: 'Starter',  monthly: 150, yearly: 1000, gens: 30,  react: false, tools: false, quality: 'low' },
  pro:      { label: 'Pro',      monthly: 300, yearly: 1500, gens: 100, react: true,  tools: true, quality: 'standard' },
  business: { label: 'Business', monthly: 500, yearly: 2000, gens: 250, react: true,  tools: true, quality: 'high' },
});
const PRO_LIMIT = (tier) => (TIERS()[tier] || TIERS().pro).gens;

const PLANS = () => {
  const out = {};
  for (const [k, t] of Object.entries(TIERS())) {
    out[k + '_monthly'] = { tier: k, days: 30, amount: t.monthly * 100, label: 'DRAW2CODE AI ' + t.label + ' — 30 days' };
    out[k + '_yearly'] = { tier: k, days: 365, amount: t.yearly * 100, label: 'DRAW2CODE AI ' + t.label + ' — 1 year' };
  }
  out.monthly = out.pro_monthly; // old keys still accepted
  out.yearly = out.pro_yearly;
  return out;
};

/** Owner-only self-check: which server settings are in place (no secrets are returned). */
async function health(user) {
  const ai = require('./_ai');
  const aiInfo = ai.info();
  const out = {
    firebaseProject: fbEnv('FIREBASE_PROJECT_ID'),
    ai: {
      provider: aiInfo.provider,
      label: aiInfo.label,
      models: aiInfo.models,
      keyName: aiInfo.keyName,
      configured: aiInfo.configured,
      configuredProviders: ai.configuredProviders().map((p) => p.label),
    },
    paymongo: (process.env.PAYMONGO_SECRET_KEY || '').trim().startsWith('sk_live_') ? 'live' : (process.env.PAYMONGO_SECRET_KEY || '').trim() ? 'test' : '',
    webhook: !!(process.env.PAYMONGO_WEBHOOK_SECRET || '').trim(),
    database: { ok: false, error: '' },
  };
  const db = getDb();
  if (!db) { out.database.error = 'Firebase project settings are missing (FIREBASE_API_KEY / FIREBASE_PROJECT_ID).'; return out; }
  try {
    if (user && user.uid) {
      // Writes and reads back a signed record under the owner's own account: proves firestore.rules are published.
      const ref = db.doc('users/' + user.uid + '/billing/health');
      await ref.set({ at: Date.now() });
      const back = await ref.get();
      if (!back.exists) throw new Error('The server could not read back what it saved. Check BILLING_SECRET / the AI key in Vercel.');
    }
    out.database.ok = true;
  } catch (e) {
    out.database.error = /NOT_FOUND|does not exist/i.test(String(e && e.message)) ? 'Firestore database is not created yet (Firebase Console > Firestore Database > Create database).' : /PERMISSION_DENIED|permission|insufficient/i.test(String(e && e.message)) ? 'Firestore rules are not published yet (Firebase Console > Firestore Database > Rules > paste firestore.rules > Publish).' : String((e && e.message) || e).slice(0, 160);
  }
  return out;
}

/** Returns { pro, tier, expiresAt } for a user. */
async function getPlan(uid) {
  const db = getDb();
  if (!db) return { pro: false, tier: '', expiresAt: 0, unknown: true };
  try {
    const s = await db.doc('users/' + uid + '/billing/plan').get();
    const d = s.exists ? s.data() : null;
    const exp = d && d.expiresAt ? Number(d.expiresAt) : 0;
    const pro = !!(d && d.plan === 'pro' && exp > Date.now());
    return { pro, tier: pro ? (TIERS()[d.tier] ? d.tier : 'pro') : '', expiresAt: exp };
  } catch (e) {
    console.error('getPlan failed:', e && e.message);
    return { pro: false, tier: '', expiresAt: 0, unknown: true };
  }
}

/** Frameworks a mode may generate. */
function frameworksFor(mode, tier) {
  if (mode === 'owner') return ['bootstrap', 'vanilla', 'react'];
  if (mode === 'paid') return (TIERS()[tier] || TIERS().pro).react ? ['bootstrap', 'vanilla', 'react'] : ['bootstrap', 'vanilla'];
  return [];
}

/** Rolling allowance: the count returns to 0 once resetAt has passed (24h after it was used up). */
function norm(ud, scope, now) {
  if (!ud || ud.scope !== scope) return { count: 0, resetAt: 0 };
  if (ud.resetAt && now >= ud.resetAt) return { count: 0, resetAt: 0 };
  return { count: ud.count || 0, resetAt: ud.resetAt || 0 };
}

const waitText = (ms) => {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
};

/** What a user is on right now and how much allowance is left. */
async function status(uid) {
  const now = Date.now();
  const plan = await getPlan(uid);
  const db = getDb();
  if (!db || !plan.pro) {
    const unknown = !db || !!plan.unknown;
    return { mode: unknown ? 'unknown' : 'unpaid', tier: plan.tier, expiresAt: plan.expiresAt, used: 0, limit: 0, resetAt: 0, unknown };
  }
  const scope = TIERS()[plan.tier] ? plan.tier : 'pro';
  const usage = await db.doc('users/' + uid + '/billing/usage').get();
  const n = norm(usage.exists ? usage.data() : null, scope, now);
  return { mode: 'paid', tier: scope, expiresAt: plan.expiresAt, used: n.count, limit: PRO_LIMIT(scope), resetAt: n.resetAt, unknown: false };
}

/**
 * Atomically checks the allowance AND uses one generation (parallel requests cannot bypass it).
 * Returns { ok:true, kind, quality, simple, scope, limit } or { ok:false, status, error, resetAt?, upgrade }.
 */
async function reserveUse(uid, framework, user) {
  if (isOwner(user)) return { ok: true, kind: 'owner', quality: 'high' };
  const db = getDb();
  if (!db) return { ok: false, status: 503, error: 'The system is not fully set up yet. Please contact the site owner.', upgrade: false };
  const planRef = db.doc('users/' + uid + '/billing/plan');
  const usageRef = db.doc('users/' + uid + '/billing/usage');
  return db.runTransaction(async (t) => {
    const now = Date.now();
    const [ps, us] = await Promise.all([t.get(planRef), t.get(usageRef)]);
    const pd = ps.exists ? ps.data() : null;
    const exp = pd && pd.expiresAt ? Number(pd.expiresAt) : 0;
    const pro = !!(pd && pd.plan === 'pro' && exp > now);
    if (!pro) {
      return { ok: false, status: 402, error: 'An active paid plan is required to use AI. Choose Starter, Pro, or Business to continue.', reason: 'subscription_required', upgrade: true };
    }
    const tier = TIERS()[pd.tier] ? pd.tier : 'pro';
    if (!frameworksFor('paid', tier).includes(framework)) {
      const msg = framework === 'react'
          ? 'React output is for the Pro and Business plans. Choose Bootstrap or Vanilla, or upgrade.'
          : 'This output is not included in your plan.';
      return { ok: false, status: 402, error: msg, reason: 'plan', upgrade: true };
    }

    const scope = tier;
    const limit = PRO_LIMIT(tier);
    const n = norm(us.exists ? us.data() : null, scope, now);
    if (n.count >= limit) {
      const back = n.resetAt || now + WINDOW_MS;
      return { ok: false, status: 402, reason: 'limit', resetAt: back, upgrade: true, error: 'You used all ' + limit + ' generations on your ' + TIERS()[tier].label + ' plan. They come back in ' + waitText(back - now) + '. Upgrade for a bigger allowance.' };
    }
    const count = n.count + 1;
    t.set(usageRef, { scope, count, resetAt: count >= limit ? now + WINDOW_MS : 0 });
    return {
      ok: true, kind: 'paid', scope, limit,
      quality: TIERS()[tier].quality,
      simple: false,
    };
  });
}

/** AI quality level a user gets: owner high, otherwise by active paid tier. */
async function qualityFor(user) {
  if (isOwner(user)) return 'high';
  try {
    const st = await status(user.uid);
    return st.mode === 'paid' ? (TIERS()[st.tier] || TIERS().pro).quality : BASIC_QUALITY;
  } catch (e) { return BASIC_QUALITY; }
}

/** Gives the generation back when the AI call fails before anything was produced. */
async function refundUse(uid, gate) {
  const db = getDb();
  if (!db || !gate || gate.kind === 'owner') return;
  try {
    const ref = db.doc('users/' + uid + '/billing/usage');
    await db.runTransaction(async (t) => {
      const s = await t.get(ref);
      const d = s.exists ? s.data() : null;
      if (d && d.scope === gate.scope && d.count > 0) {
        const count = d.count - 1;
        t.set(ref, { scope: d.scope, count, resetAt: count >= gate.limit ? d.resetAt || 0 : 0 });
      }
    });
  } catch (e) { console.error('refund failed:', e && e.message); }
}

/** Grants a paid plan once per PayMongo checkout session (idempotent). */
async function grantPro(uid, sessionId, planKey, paidAmount) {
  const db = getDb();
  if (!db) throw new Error('Firebase project settings are missing on the server.');
  const plan = PLANS()[planKey] || PLANS().pro_monthly;
  const payRef = db.doc('users/' + uid + '/payments/' + sessionId);
  const planRef = db.doc('users/' + uid + '/billing/plan');
  return db.runTransaction(async (t) => {
    const [pay, cur] = await Promise.all([t.get(payRef), t.get(planRef)]);
    if (pay.exists) return { already: true, expiresAt: (cur.exists && cur.data().expiresAt) || 0 };
    const base = Math.max(Date.now(), cur.exists ? Number(cur.data().expiresAt) || 0 : 0);
    const expiresAt = base + plan.days * 86400000;
    t.set(payRef, { sessionId, plan: planKey, tier: plan.tier, amount: paidAmount || plan.amount, method: 'gcash', provider: 'paymongo', paidAt: Date.now() });
    t.set(planRef, { plan: 'pro', tier: plan.tier, expiresAt, lastPlan: planKey, updatedAt: Date.now() });
    return { already: false, expiresAt };
  });
}

module.exports = { status, frameworksFor, qualityFor, BASIC_QUALITY, health, fbEnv, FIREBASE_DEFAULTS, isOwner, getDb, send, verifyToken, bearer, readBody, getPlan, reserveUse, refundUse, grantPro, PLANS, TIERS, PRO_LIMIT, WINDOW_MS };
