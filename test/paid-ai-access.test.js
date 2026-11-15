'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const tiers = {
  starter: { label: 'Starter', monthly: 150, yearly: 1000, gens: 30, react: false, tools: false, quality: 'low' },
  pro: { label: 'Pro', monthly: 300, yearly: 1500, gens: 100, react: true, tools: true, quality: 'standard' },
  business: { label: 'Business', monthly: 500, yearly: 2000, gens: 250, react: true, tools: true, quality: 'high' },
};

function response() {
  return {
    headers: {},
    writes: '',
    setHeader(name, value) { this.headers[name] = value; },
    on() {},
    write(chunk) { this.writes += chunk; return true; },
    end(body) { this.body = body; this.writableEnded = true; },
    flushHeaders() {},
  };
}

function loadHandler(name, { owner = false, plan = { pro: false }, aiOpen } = {}) {
  const file = require.resolve('../api/' + name);
  delete require.cache[file];
  const ai = {
    QUALITY: {
      low: { label: 'Low', speed: 'fast' },
      standard: { label: 'Standard', speed: 'balanced' },
      high: { label: 'High', speed: 'thorough' },
    },
    DEFAULT_MODEL: { gemini: { low: 'test-model' } },
    info: () => ({ configured: true }),
    outputTokens: () => 1200,
    open: aiOpen || (async () => ({
      ok: true,
      read: async (onText) => { onText('mock reply'); return {}; },
    })),
  };
  const admin = {
    send(res, status, body) {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    },
    verifyToken: async () => ({ uid: 'user-1', email: 'owner@example.com', emailVerified: true }),
    bearer: () => 'token',
    readBody: (req) => req.body,
    getPlan: async () => plan,
    isOwner: () => owner,
    PLANS: () => ({ pro_monthly: { tier: 'pro', days: 30, amount: 30000, label: 'Pro' } }),
    status: async () => ({ mode: 'unpaid', used: 0, limit: 0 }),
    TIERS: () => tiers,
    qualityFor: async () => 'low',
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === file) {
      if (request === './_ai') return ai;
      if (request === './_admin') return admin;
      if (request === './version') return { floorVersion: () => 20 };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(file);
  } finally {
    Module._load = originalLoad;
  }
}

async function call(handler) {
  const res = response();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: { messages: [{ role: 'user', content: 'hello' }] },
  }, res);
  return res;
}

function loadAdmin(fakeDb) {
  const file = require.resolve('../api/_admin');
  delete require.cache[file];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === file && request === './_firestore') {
      return { createDb: () => fakeDb, rememberToken() {} };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(file);
  } finally {
    Module._load = originalLoad;
  }
}

function fakeFirestore(plan, usage = null) {
  const writes = [];
  return {
    writes,
    doc(path) { return { path }; },
    runTransaction(callback) {
      return callback({
        async get(ref) {
          if (ref.path.endsWith('/billing/plan')) return { exists: !!plan, data: () => plan };
          return { exists: !!usage, data: () => usage };
        },
        set(ref, value) { writes.push({ path: ref.path, value }); },
      });
    },
  };
}

test('generation reservation rejects users without a paid plan', async () => {
  const db = fakeFirestore(null);
  const admin = loadAdmin(db);
  const result = await admin.reserveUse('user-1', 'bootstrap', { email: 'user@example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.equal(db.writes.length, 0);
});

test('generation reservation allows an active paid plan and records usage', async () => {
  const db = fakeFirestore({ plan: 'pro', tier: 'starter', expiresAt: Date.now() + 86400000 });
  const admin = loadAdmin(db);
  const result = await admin.reserveUse('user-1', 'bootstrap', { email: 'user@example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'paid');
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].value.count, 1);
});

test('generation reservation does not require Firestore for the verified owner', async () => {
  const admin = loadAdmin(null);
  const result = await admin.reserveUse('owner-1', 'react', {
    email: 'ronielnyke@gmail.com',
    emailVerified: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'owner');
});

test('generation reservation fails closed when Firestore is unavailable', async () => {
  const admin = loadAdmin(null);
  const result = await admin.reserveUse('user-1', 'bootstrap', { email: 'user@example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test('owner access requires a verified email on the configured owner list', () => {
  const previous = process.env.OWNER_EMAIL;
  process.env.OWNER_EMAIL = 'owner-test@example.com';
  try {
    const admin = loadAdmin(null);
    assert.equal(admin.isOwner({ email: 'owner-test@example.com', emailVerified: false }), false);
    assert.equal(admin.isOwner({ email: 'owner-test@example.com', emailVerified: true }), true);
    assert.equal(admin.isOwner({ email: 'other@example.com', emailVerified: true }), false);
  } finally {
    if (previous === undefined) delete process.env.OWNER_EMAIL;
    else process.env.OWNER_EMAIL = previous;
  }
});

test('checkout refuses to charge the verified owner', async () => {
  const previous = process.env.PAYMONGO_SECRET_KEY;
  process.env.PAYMONGO_SECRET_KEY = 'sk_test_mock';
  try {
    const handler = loadHandler('checkout', { owner: true });
    const res = await call(handler);
    assert.equal(res.statusCode, 409);
    assert.match(JSON.parse(res.body).error, /no payment is needed/i);
  } finally {
    if (previous === undefined) delete process.env.PAYMONGO_SECRET_KEY;
    else process.env.PAYMONGO_SECRET_KEY = previous;
  }
});

for (const route of ['assistant', 'debug']) {
  test(route + ' denies AI access without an active plan', async () => {
    const handler = loadHandler(route, { plan: { pro: false, unknown: false } });
    const res = await call(handler);
    assert.equal(res.statusCode, 402);
    assert.match(JSON.parse(res.body).error, /active paid plan is required/i);
  });

  test(route + ' fails closed when plan status is unknown', async () => {
    const handler = loadHandler(route, { plan: { pro: false, unknown: true } });
    const res = await call(handler);
    assert.equal(res.statusCode, 503);
  });

  test(route + ' allows the verified owner without a paid plan', async () => {
    const handler = loadHandler(route, { owner: true, plan: { pro: false } });
    const res = await call(handler);
    assert.equal(res.statusCode, 200);
    assert.equal(res.writes, 'mock reply');
  });
}
