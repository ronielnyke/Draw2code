'use strict';
// GET  /api/billing                 -> { pro, expiresAt, used, limit, configured }
// POST /api/billing { sessionId }   -> verifies a PayMongo checkout session and activates the plan
const { health, isOwner, send, verifyToken, bearer, readBody, status, frameworksFor, TIERS, grantPro, getDb, PLANS, WINDOW_MS } = require('./_admin');

function paidInfo(d) {
  const a = (d && d.attributes) || {};
  const pays = Array.isArray(a.payments) ? a.payments : [];
  const paid = pays.find((p) => p && p.attributes && p.attributes.status === 'paid');
  const intentOk = a.payment_intent && a.payment_intent.attributes && a.payment_intent.attributes.status === 'succeeded';
  const amount = paid ? paid.attributes.amount : (intentOk ? Number(a.payment_intent.attributes.amount) || 0 : 0);
  return { paid: !!(paid || intentOk), amount, meta: a.metadata || {}, live: a.livemode };
}

// Activates any paid checkout of this user that has not been activated yet (buyer closed the tab, paid on another device,
// or the webhook has no signed-in user to write for). Throttled, and never throws.
const settled = new Set();
const lastCheck = new Map();
async function reconcile(user) {
  const secret = (process.env.PAYMONGO_SECRET_KEY || '').trim();
  const db = getDb();
  if (!secret || !db) return;
  const now = Date.now();
  if (now - (lastCheck.get(user.uid) || 0) < 60000) return;
  lastCheck.set(user.uid, now);
  if (lastCheck.size > 500) for (const [k, v] of lastCheck) if (now - v > 600000) lastCheck.delete(k);
  try {
    const snap = await db.collection('users/' + user.uid + '/checkouts').orderBy('createdAt', 'desc').limit(5).get();
    for (const d of snap.docs) {
      const c = d.data() || {};
      if (settled.has(d.id) || now - (Number(c.createdAt) || 0) > 3 * 86400000) continue;
      const r = await fetch('https://api.paymongo.com/v1/checkout_sessions/' + encodeURIComponent(d.id), { headers: { Authorization: 'Basic ' + Buffer.from(secret + ':').toString('base64') } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) continue;
      const info = paidInfo(j.data);
      const expected = PLANS()[info.meta.plan];
      if (info.meta.uid !== user.uid || !info.paid || !expected || info.amount < expected.amount) continue;
      await grantPro(user.uid, d.id, info.meta.plan, info.amount);
      settled.add(d.id);
    }
  } catch (e) { console.error('reconcile failed:', e && e.message); }
}

module.exports = async function handler(req, res) {
  const user = await verifyToken(bearer(req));
  if (!user) return send(res, 401, { error: 'Please sign in again to continue.' });

  if (req.method === 'GET') {
    const paymentsLive = (process.env.PAYMONGO_SECRET_KEY || '').trim().startsWith('sk_live_');
    const payments = !!(process.env.PAYMONGO_SECRET_KEY || '').trim();
    if (isOwner(user)) return send(res, 200, { pro: true, owner: true, tools: true, mode: 'owner', tier: 'owner', expiresAt: 0, used: 0, limit: 0, resetAt: 0, frameworks: frameworksFor('owner'), unknown: false, configured: !!getDb(), payments, paymentsLive, setup: await health(user) });
    await reconcile(user);
    const st = await status(user.uid);
    return send(res, 200, {
      pro: st.mode === 'paid',
      tools: st.mode === 'paid' && !!(TIERS()[st.tier] || TIERS().pro).tools,
      mode: st.mode,
      tier: st.tier,
      expiresAt: st.expiresAt,
      used: st.used,
      limit: st.limit,
      resetAt: st.resetAt,
      windowHours: WINDOW_MS / 3600000,
      frameworks: frameworksFor(st.mode, st.tier),
      unknown: !!st.unknown,
      configured: !!getDb(),
      payments,
      paymentsLive,
    });
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return send(res, 405, { error: 'Method not allowed' }); }

  const secret = (process.env.PAYMONGO_SECRET_KEY || '').trim();
  if (!secret) return send(res, 503, { error: 'Payments are not set up yet.' });
  const body = readBody(req) || {};
  let ids = [];
  const one = String(body.sessionId || '').replace(/[^\w-]/g, '');
  if (one) ids = [one];
  else {
    // No session given (different browser/device): check this user's most recent checkouts.
    try {
      const db = getDb();
      if (db) {
        const snap = await db.collection('users/' + user.uid + '/checkouts').orderBy('createdAt', 'desc').limit(5).get();
        ids = snap.docs.map((d) => d.id);
      }
    } catch (e) { console.error('pending lookup failed:', e && e.message); }
  }
  if (!ids.length) return send(res, 200, { paid: false, message: 'No pending payment was found for this account.' });

  try {
    let last = null;
    for (const sessionId of ids) {
      const r = await fetch('https://api.paymongo.com/v1/checkout_sessions/' + sessionId, {
        headers: { Authorization: 'Basic ' + Buffer.from(secret + ':').toString('base64') },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { if (one) return send(res, 404, { error: 'Payment session was not found.' }); continue; }
      const info = paidInfo(j.data);
      if (info.meta.uid !== user.uid) { if (one) return send(res, 403, { error: 'This payment belongs to a different account.' }); continue; }
      if (!info.paid) { last = last || { paid: false, message: 'Payment is not completed yet.' }; continue; }
      const expected = PLANS()[info.meta.plan];
      if (!expected || info.amount < expected.amount) { if (one) return send(res, 400, { error: 'The paid amount does not match the plan.' }); continue; }
      const out = await grantPro(user.uid, sessionId, info.meta.plan, info.amount);
      return send(res, 200, { paid: true, pro: true, expiresAt: out.expiresAt, already: out.already });
    }
    return send(res, 200, last || { paid: false, message: 'Payment is not completed yet.' });
  } catch (e) {
    console.error('billing verify failed:', e && e.message);
    return send(res, 500, { error: 'Could not confirm the payment. If you were charged, it will be activated automatically within a few minutes.' });
  }
};
