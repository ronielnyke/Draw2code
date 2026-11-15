'use strict';

// Serves the PUBLIC Firebase web config from Vercel environment variables,
// so no keys are hard-coded in the repository. (Firebase web keys are not secrets;
// access is protected by Firebase Auth + Firestore rules.)

const { TIERS, fbEnv, TRIAL_QUALITY, BASIC_QUALITY, FREE_LIMIT, WINDOW_MS } = require('./_admin');
const ai = require('./_ai');

// What a quality level really means (shown on the pricing cards).
const spec = (q) => ({ quality: q, qualityLabel: ai.QUALITY[q].label, speed: ai.QUALITY[q].speed, blurb: ai.QUALITY[q].blurb, outputTokens: ai.outputTokens(q) });

const REQUIRED = {
  apiKey: 'FIREBASE_API_KEY',
  authDomain: 'FIREBASE_AUTH_DOMAIN',
  projectId: 'FIREBASE_PROJECT_ID',
  appId: 'FIREBASE_APP_ID',
};

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { error: 'Method not allowed' });
  }

  const firebase = {};
  const missing = [];
  for (const [key, envName] of Object.entries(REQUIRED)) {
    const v = fbEnv(envName);
    if (v) firebase[key] = v;
    else missing.push(envName);
  }
  // Show the site's own address (draw2code-ai.vercel.app) on the Google sign-in screen. The sign-in pages are served
  // from this domain through the /__/auth rewrite in vercel.json. Other hosts (previews, localhost) keep the default.
  const own = new URL(/^https?:\/\//.test(process.env.PUBLIC_URL || '') ? process.env.PUBLIC_URL.trim() : 'https://draw2code-ai.vercel.app').host;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (host && host === own.toLowerCase()) firebase.authDomain = host;
  const sender = fbEnv('FIREBASE_MESSAGING_SENDER_ID');
  const bucket = fbEnv('FIREBASE_STORAGE_BUCKET');
  if (sender) firebase.messagingSenderId = sender;
  if (bucket) firebase.storageBucket = bucket;

  if (missing.length) {
    res.setHeader('Cache-Control', 'no-store');
    return send(res, 500, { error: 'Missing environment variables', missing });
  }

  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  return send(res, 200, { firebase, ai: ai.info().configured, aiKey: ai.info().keyName, payments: Boolean((process.env.PAYMONGO_SECRET_KEY || '').trim()), trialDays: 7, freeGenerations: FREE_LIMIT(), windowHours: WINDOW_MS / 3600000, paymentsLive: (process.env.PAYMONGO_SECRET_KEY || '').trim().startsWith('sk_live_'),
    free: { ...spec(TRIAL_QUALITY) },
    tiers: Object.fromEntries(Object.entries(TIERS()).map(([k, t]) => [k, { label: t.label, monthly: t.monthly, yearly: t.yearly, gens: t.gens, react: t.react, tools: t.tools, ...spec(t.quality) }])) });
};
