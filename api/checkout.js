'use strict';
// POST /api/checkout  { plan: 'monthly' | 'yearly' }  -> { url }
// Creates a PayMongo Checkout Session that accepts GCash.
const { send, verifyToken, bearer, readBody, getDb, isOwner, PLANS } = require('./_admin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'Method not allowed' }); }
  const secret = (process.env.PAYMONGO_SECRET_KEY || '').trim();
  if (!secret) return send(res, 503, { error: 'Payments are not set up yet. Add PAYMONGO_SECRET_KEY in Vercel.' });

  const user = await verifyToken(bearer(req));
  if (!user) return send(res, 401, { error: 'Please sign in again to continue.' });
  if (isOwner(user)) return send(res, 409, { error: 'The verified owner already has unlimited access. No payment is needed.' });

  const body = readBody(req) || {};
  const planKey = PLANS()[body.plan] ? body.plan : 'pro_monthly';
  const plan = PLANS()[planKey];
  const origin = (process.env.PUBLIC_URL || (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host).replace(/\/$/, '');

  try {
    const r = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(secret + ':').toString('base64') },
      body: JSON.stringify({
        data: {
          attributes: {
            line_items: [{ currency: 'PHP', amount: plan.amount, name: plan.label, quantity: 1 }],
            payment_method_types: ['gcash'],
            description: plan.label,
            send_email_receipt: true,
            show_description: true,
            show_line_items: true,
            reference_number: 'D2C-' + user.uid.slice(0, 6) + '-' + Date.now(),
            success_url: origin + '/#/account?paid=1',
            cancel_url: origin + '/#/pricing?cancelled=1',
            metadata: { uid: user.uid, plan: planKey },
            billing: user.email ? { email: user.email } : undefined,
          },
        },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('PayMongo checkout error', r.status, JSON.stringify(j).slice(0, 500));
      const msg = j && j.errors && j.errors[0] && j.errors[0].detail;
      return send(res, 502, { error: 'Could not start the GCash payment.' + (msg ? ' ' + msg : '') });
    }
    const d = j.data;
    // Remember it on the server so "Check payment" works even from another browser or device.
    try { const db = getDb(); if (db) await db.doc('users/' + user.uid + '/checkouts/' + d.id).set({ plan: planKey, createdAt: Date.now() }); } catch (e) { console.error('checkout save failed:', e && e.message); }
    return send(res, 200, { id: d.id, url: d.attributes.checkout_url });
  } catch (e) {
    console.error('checkout failed:', e && e.message);
    return send(res, 502, { error: 'Could not reach the payment service. Please try again.' });
  }
};
