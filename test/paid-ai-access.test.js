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
    getDb: () => null,
    isOwner: () => owner,
    PLANS: () => ({
      pro_monthly: { tier: 'pro', days: 30, amount: 30000, label: 'Pro' },
      pro_yearly: { tier: 'pro', days: 365, amount: 150000, label: 'Pro' },
      starter_yearly: { tier: 'starter', days: 365, amount: 100000, label: 'Starter' },
    }),
    startTrial: async () => ({ ok: true, expiresAt: Date.now() + 7 * 86400000 }),
    trialUsed: async () => false,
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

async function call(handler, overrides = {}) {
  const res = response();
  await handler({
    method: overrides.method || 'POST',
    headers: { authorization: 'Bearer token' },
    body: overrides.body || { messages: [{ role: 'user', content: 'hello' }] },
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

function fakeTrialFirestore(initial = {}) {
  const records = new Map(Object.entries(initial));
  return {
    records,
    doc(path) {
      return {
        path,
        async get() {
          const value = records.get(path);
          return { exists: !!value, data: () => value };
        },
      };
    },
    runTransaction(callback) {
      return callback({
        async get(ref) {
          const value = records.get(ref.path);
          return { exists: !!value, data: () => value };
        },
        set(ref, value) { records.set(ref.path, value); },
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
  assert.equal(result.quality, 'high');
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].value.count, 1);
});

test('generation reservation gives an active Pro trial Standard quality and a separate allowance', async () => {
  const db = fakeFirestore({ plan: 'trial', tier: 'pro', expiresAt: Date.now() + 7 * 86400000 });
  const admin = loadAdmin(db);
  const result = await admin.reserveUse('user-1', 'react', { email: 'user@example.com' });
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'trial');
  assert.equal(result.limit, 10);
  assert.equal(result.quality, 'standard');
  assert.equal(db.writes[0].value.scope, 'trial');
});

test('generation reservation enforces the trial allowance', async () => {
  const db = fakeFirestore(
    { plan: 'trial', tier: 'pro', expiresAt: Date.now() + 7 * 86400000 },
    { scope: 'trial', count: 10, resetAt: Date.now() + 3600000 },
  );
  const admin = loadAdmin(db);
  const result = await admin.reserveUse('user-1', 'bootstrap', { email: 'user@example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.match(result.error, /free trial/);
});

test('AI quality follows the trial and paid-plan quality settings', async () => {
  const trialAdmin = loadAdmin(fakeTrialFirestore({
    'users/user-1/billing/plan': { plan: 'trial', tier: 'pro', expiresAt: Date.now() + 86400000 },
  }));
  assert.equal(await trialAdmin.qualityFor({ uid: 'user-1', email: 'user@example.com' }), 'standard');

  const paidAdmin = loadAdmin(fakeTrialFirestore({
    'users/user-1/billing/plan': { plan: 'pro', tier: 'starter', expiresAt: Date.now() + 86400000 },
  }));
  assert.equal(await paidAdmin.qualityFor({ uid: 'user-1', email: 'user@example.com' }), 'high');
});

test('Pro has a yearly plan and all paid tiers use High quality', () => {
  const admin = loadAdmin(null);
  const plans = admin.PLANS();
  assert.equal(plans.pro_yearly.days, 365);
  assert.deepEqual(Object.values(admin.TIERS()).map((tier) => tier.quality), ['high', 'high', 'high']);
});

test('a Pro trial is granted for seven days only once per account', async () => {
  const db = fakeTrialFirestore();
  const admin = loadAdmin(db);
  const started = await admin.startTrial('user-1');
  assert.equal(started.ok, true);
  assert.equal(started.expiresAt - db.records.get('users/user-1/billing/trial').startedAt, 7 * 86400000);
  assert.deepEqual(db.records.get('users/user-1/billing/plan'), {
    plan: 'trial',
    tier: 'pro',
    expiresAt: started.expiresAt,
    updatedAt: db.records.get('users/user-1/billing/trial').startedAt,
  });
  assert.deepEqual(await admin.startTrial('user-1'), { ok: false, reason: 'already_used' });
});

test('an expired legacy trial cannot be started again', async () => {
  const db = fakeTrialFirestore({
    'users/user-1/billing/plan': { plan: 'trial', tier: 'pro', expiresAt: Date.now() - 86400000 },
  });
  const admin = loadAdmin(db);
  assert.equal(await admin.trialUsed('user-1'), true);
  assert.deepEqual(await admin.startTrial('user-1'), { ok: false, reason: 'already_used' });
});

test('billing route starts the free trial without requiring PayMongo setup', async () => {
  const handler = loadHandler('billing');
  const res = await call(handler, { body: { action: 'start-trial' } });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).trial, true);
});

test('checkout rejects yearly Starter purchases', async () => {
  const previous = process.env.PAYMONGO_SECRET_KEY;
  process.env.PAYMONGO_SECRET_KEY = 'sk_test_mock';
  try {
    const handler = loadHandler('checkout');
    const res = await call(handler, { body: { plan: 'starter_yearly' } });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /Yearly billing is Pro only/);
  } finally {
    if (previous === undefined) delete process.env.PAYMONGO_SECRET_KEY;
    else process.env.PAYMONGO_SECRET_KEY = previous;
  }
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
    assert.match(JSON.parse(res.body).error, /active (paid )?plan.*required/i);
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

test('Help assistant uses Standard quality for the Pro trial', async () => {
  let quality = '';
  const handler = loadHandler('assistant', {
    plan: { pro: true, trial: true, tier: 'pro' },
    aiOpen: async (args) => {
      quality = args.quality;
      return { ok: true, read: async (onText) => { onText('trial reply'); return {}; } };
    },
  });
  const res = await call(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(quality, 'standard');
});
