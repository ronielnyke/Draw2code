'use strict';

// Firestore over the public REST API. No private key and no admin SDK are needed.
//
// It gives api/_admin.js the small subset of the Firestore API it uses (doc().get/set, collection().orderBy().limit().get,
// runTransaction with t.get/t.set). Requests are made with the signed-in user's own Firebase ID token (so Firestore
// rules apply) or, for public documents such as meta/version, with no user at all.
//
// Because the server has no admin power, billing records (users/{uid}/billing/*, users/{uid}/payments/*) are SIGNED with an
// HMAC made from a server-side secret. A record without a valid signature is treated as if it does not exist, so a user can
// never write "plan: pro" for themselves: they cannot produce the signature.

const crypto = require('crypto');

// ------------------------------------------------------------------ user tokens (kept in memory, per server instance)
const tokens = new Map(); // uid -> { token, at }
const TOKEN_TTL = 50 * 60 * 1000; // Firebase ID tokens last 60 minutes

function rememberToken(uid, token) {
  if (!uid || !token) return;
  const now = Date.now();
  tokens.set(uid, { token, at: now });
  if (tokens.size > 500) for (const [k, v] of tokens) if (now - v.at > TOKEN_TTL) tokens.delete(k);
}
function tokenFor(path) {
  const m = /^users\/([^/]+)\//.exec(path);
  if (!m) return '';
  const t = tokens.get(m[1]);
  return t && Date.now() - t.at < TOKEN_TTL ? t.token : '';
}

// ------------------------------------------------------------------ signing of billing records
const SIGNED = /^users\/[^/]+\/(billing|payments)\/[^/]+$/;

// Server-side secrets that already exist for other reasons. BILLING_SECRET (optional) wins; the first one found signs,
// every one found is accepted when verifying, so adding a new secret later never invalidates old records.
function secrets() {
  const e = (n) => String(process.env[n] || '').trim();
  const list = [e('BILLING_SECRET'), e('ANTHROPIC_API_KEY'), e('GEMINI_API_KEY'), e('GOOGLE_API_KEY'), e('OPENAI_API_KEY'), e('PAYMONGO_SECRET_KEY'), e('PAYMONGO_WEBHOOK_SECRET')].filter(Boolean);
  return list.length ? list : ['draw2code-no-secret-configured'];
}
const mac = (secret, path, data) =>
  crypto.createHmac('sha256', crypto.createHmac('sha256', secret).update('d2c-billing-v1').digest()).update(path + '\n' + canon(data)).digest('hex');

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function validSig(path, data, sig) {
  if (typeof sig !== 'string' || sig.length !== 64) return false;
  const given = Buffer.from(sig);
  return secrets().some((s) => {
    const want = Buffer.from(mac(s, path, data));
    return want.length === given.length && crypto.timingSafeEqual(want, given);
  });
}

// ------------------------------------------------------------------ Firestore value encoding
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: Number.isFinite(v) ? v : 0 };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: fieldsOf(v) } };
}
function fieldsOf(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) f[k] = enc(v);
  return f;
}
function dec(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue) || 0;
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(dec);
  if ('mapValue' in v) return objOf((v.mapValue && v.mapValue.fields) || {});
  return null;
}
function objOf(fields) {
  const o = {};
  for (const [k, v] of Object.entries(fields || {})) o[k] = dec(v);
  return o;
}

// ------------------------------------------------------------------ database
function createDb({ projectId, apiKey, referer }) {
  if (!projectId || !apiKey) return null;
  const root = 'projects/' + encodeURIComponent(projectId) + '/databases/(default)/documents';
  const base = 'https://firestore.googleapis.com/v1/' + root;
  const q = (extra) => '?key=' + encodeURIComponent(apiKey) + (extra || '');
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

  function needToken(path) {
    const t = tokenFor(path);
    if (!t && /^users\//.test(path)) {
      const e = new Error('No signed-in user is attached to this request, so the server cannot access ' + path.split('/').slice(0, 2).join('/') + '.');
      e.code = 'NO_USER_TOKEN';
      throw e;
    }
    return t;
  }

  async function call(method, url, token, body) {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(referer ? { Referer: referer } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { error: { message: text.slice(0, 200) } }; }
    const err = ((Array.isArray(json) ? json[0] : json) || {}).error;
    return { ok: r.ok && !err, status: r.status, json, err };
  }
  function fail(res, what) {
    const e = new Error((res.err && res.err.message) || what + ' failed (HTTP ' + res.status + ').');
    e.code = (res.err && res.err.status) || String(res.status);
    e.httpStatus = res.status;
    return e;
  }
  const isMissingDoc = (res) => res.status === 404 && !/database/i.test((res.err && res.err.message) || '');

  function snap(path, doc) {
    if (!doc) return { id: path.split('/').pop(), exists: false, data: () => undefined };
    let data = objOf(doc.fields);
    if (SIGNED.test(path)) {
      const sig = data.sig;
      delete data.sig;
      if (!validSig(path, data, sig)) return { id: path.split('/').pop(), exists: false, data: () => undefined };
    }
    return { id: path.split('/').pop(), exists: true, data: () => data };
  }

  async function getDoc(path, txId) {
    const res = await call('GET', base + '/' + encPath(path) + q(txId ? '&transaction=' + encodeURIComponent(txId) : ''), needToken(path));
    if (res.ok) return snap(path, res.json);
    if (isMissingDoc(res)) return snap(path, null);
    throw fail(res, 'Reading ' + path);
  }

  function body(path, data) {
    const d = { ...data };
    delete d.sig;
    if (SIGNED.test(path)) d.sig = mac(secrets()[0], path, d);
    return { name: root + '/' + path, fields: fieldsOf(d) };
  }

  async function setDoc(path, data) {
    const res = await call('PATCH', base + '/' + encPath(path) + q(), needToken(path), { fields: body(path, data).fields });
    if (!res.ok) throw fail(res, 'Writing ' + path);
  }

  function doc(path) {
    return { path, id: path.split('/').pop(), get: () => getDoc(path), set: (data) => setDoc(path, data) };
  }

  function collection(path) {
    const spec = { field: '', dir: 'ASCENDING', n: 0 };
    const api = {
      orderBy(field, dir) { spec.field = field; spec.dir = String(dir || 'asc').toLowerCase().startsWith('d') ? 'DESCENDING' : 'ASCENDING'; return api; },
      limit(n) { spec.n = n; return api; },
      async get() {
        const parts = path.split('/');
        const id = parts.pop();
        const parent = parts.join('/');
        const sq = { from: [{ collectionId: id }] };
        if (spec.field) sq.orderBy = [{ field: { fieldPath: spec.field }, direction: spec.dir }];
        if (spec.n) sq.limit = spec.n;
        const res = await call('POST', base + (parent ? '/' + encPath(parent) : '') + ':runQuery' + q(), needToken(path + '/x'), { structuredQuery: sq });
        if (!res.ok) throw fail(res, 'Listing ' + path);
        const docs = (Array.isArray(res.json) ? res.json : []).filter((r) => r && r.document).map((r) => {
          const full = r.document.name.split('/documents/')[1];
          return snap(full, r.document);
        }).filter((s) => s.exists);
        return { docs, empty: !docs.length, size: docs.length };
      },
    };
    return api;
  }

  async function runTransaction(fn) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
      let txId = '';
      let token = '';
      const writes = [];
      const t = {
        async get(ref) {
          if (!txId) {
            token = needToken(ref.path);
            const b = await call('POST', base + ':beginTransaction' + q(), token, { options: { readWrite: {} } });
            if (!b.ok) throw fail(b, 'Starting a transaction');
            txId = b.json.transaction;
          }
          return getDoc(ref.path, txId);
        },
        set(ref, data) { if (!token) token = needToken(ref.path); writes.push({ update: body(ref.path, data) }); return t; },
      };
      try {
        const out = await fn(t);
        if (!writes.length) {
          if (txId) await call('POST', base + ':rollback' + q(), token, { transaction: txId }).catch(() => {});
          return out;
        }
        const c = await call('POST', base + ':commit' + q(), token, txId ? { writes, transaction: txId } : { writes });
        if (c.ok) return out;
        last = fail(c, 'Saving');
        if (c.status === 409 || (c.err && c.err.status === 'ABORTED')) { await new Promise((r) => setTimeout(r, 60 * (attempt + 1))); continue; }
        throw last;
      } catch (e) {
        if (txId && !e.__committed) call('POST', base + ':rollback' + q(), token, { transaction: txId }).catch(() => {});
        if (e && (e.code === 'ABORTED' || e.httpStatus === 409)) { last = e; await new Promise((r) => setTimeout(r, 60 * (attempt + 1))); continue; }
        throw e;
      }
    }
    throw last || new Error('Transaction failed.');
  }

  return { doc, collection, runTransaction };
}

module.exports = { createDb, rememberToken };
