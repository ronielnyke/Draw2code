'use strict';
// POST /api/aitest  (owner only) - makes tiny REAL requests to the configured AI provider, one per
// quality level (low / standard / high), and reports whether each works.
const ai = require('./_ai');
const { send, verifyToken, bearer, isOwner } = require('./_admin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'Method not allowed' }); }
  const user = await verifyToken(bearer(req));
  if (!user) return send(res, 401, { error: 'Please sign in again.' });
  if (!isOwner(user)) return send(res, 403, { error: 'Only the owner can run this test.' });
  const base = ai.info();
  const results = await Promise.all(['low', 'standard', 'high'].map(async (q) => {
    const started = Date.now();
    const cfg = ai.info(q);
    const r = await ai.ask('You are a connectivity test. Reply with exactly: OK', 'Reply with exactly: OK', 1500, q);
    return { quality: q, model: cfg.model, ok: r.ok, reply: r.ok ? r.text.slice(0, 40) : '', error: r.ok ? '' : r.message, ms: Date.now() - started };
  }));
  return send(res, 200, { provider: base.provider, label: base.label, results });
};
