'use strict';
// POST /api/paymongo-webhook — backup activation if the buyer closes the tab after paying.
// PayMongo Dashboard -> Developers -> Webhooks: event checkout_session.payment.paid -> https://YOUR-DOMAIN/api/paymongo-webhook
const crypto = require('crypto');
const { send, grantPro, PLANS } = require('./_admin');

function raw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'Method not allowed' }); }
  const secret = (process.env.PAYMONGO_WEBHOOK_SECRET || '').trim();
  if (!secret) return send(res, 503, { error: 'Webhook secret is not configured.' });

  let text;
  try { text = await raw(req); } catch (e) { return send(res, 400, { error: 'Bad body' }); }

  const header = String(req.headers['paymongo-signature'] || '');
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((p) => p.length === 2));
  const expected = crypto.createHmac('sha256', secret).update((parts.t || '') + '.' + text).digest('hex');
  const given = parts.li || parts.te || '';
  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return send(res, 401, { error: 'Invalid signature' });

  try {
    const ev = JSON.parse(text);
    const attr = ev && ev.data && ev.data.attributes;
    if (attr && attr.type === 'checkout_session.payment.paid') {
      const s = attr.data;
      const meta = (s && s.attributes && s.attributes.metadata) || {};
      const pays = Array.isArray(s && s.attributes && s.attributes.payments) ? s.attributes.payments : [];
      const paid = pays.find((p) => p && p.attributes && p.attributes.status === 'paid');
      const amount = paid ? Number(paid.attributes.amount) || 0 : 0;
      const expected = PLANS()[meta.plan];
      // Only activate when a real paid payment covers the plan price.
      if (meta.uid && s.id && expected && amount >= expected.amount) {
        // The server can only write a user's plan while that user is signed in, so the
        // plan is activated automatically the next time the buyer opens the site (see /api/billing). Not an error.
        try { await grantPro(meta.uid, s.id, meta.plan, amount); } catch (e) { if (!e || e.code !== 'NO_USER_TOKEN') throw e; }
      } else console.error('webhook ignored: paid amount does not match plan', s && s.id, amount, meta.plan);
    }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('webhook failed:', e && e.message);
    return send(res, 500, { error: 'Webhook processing failed' });
  }
};
module.exports.config = { api: { bodyParser: false } };
