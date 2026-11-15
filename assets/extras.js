// DRAW2CODE AI v2 — pages router, plans/GCash, ROI calculator, AI Debugger, Help assistant, version check.
// Runs next to app.js and talks to it through window.D2C and the d2c:* events.

const FALLBACK_VERSION = '2.4.7'; // only a last resort; the real number is automatic (see initVersion)
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const D2C = () => window.D2C;
const toast = (m, t = 'info', ms) => (D2C() ? D2C().toast(m, t, ms) : console.log(m));
const peso = (n) => '₱' + Math.round(n).toLocaleString('en-PH');
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

const TITLES = {
  home: 'DRAW2CODE AI — Image to Website Code Generator',
  how: 'How it works · DRAW2CODE AI',
  features: 'Features · DRAW2CODE AI',
  studio: 'Studio · DRAW2CODE AI',
  projects: 'My Projects · DRAW2CODE AI',
  pricing: 'Plans & Pricing · DRAW2CODE AI',
  debug: 'AI Debugger · DRAW2CODE AI',
  login: 'Sign in · DRAW2CODE AI',
  account: 'Account & Plan · DRAW2CODE AI',
  changelog: "What's new · DRAW2CODE AI",
  tools: 'Pro Tools · DRAW2CODE AI',
  license: 'License · DRAW2CODE AI',
};

const ex = { free: null, cfg: { payments: true, live: true }, plan: { pro: false, expiresAt: 0, used: 0, limit: 10, configured: false, payments: false }, tiers: { starter: { label: 'Starter', monthly: 150, yearly: 1000, gens: 30 }, pro: { label: 'Pro', monthly: 300, yearly: 1500, gens: 100 }, business: { label: 'Business', monthly: 500, yearly: 2000, gens: 250 } }, period: 'monthly', chat: [], busy: null, lastError: '' };

/* ---------------------------------------------------------------- Router */
function currentRoute() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('?')[0].toLowerCase();
  return TITLES[raw] ? raw : 'home';
}

function route() {
  const name = currentRoute();
  $$('.page').forEach((p) => { p.hidden = p.dataset.page !== name; });
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  document.title = TITLES[name];
  window.scrollTo(0, 0);
  const menu = $('#navMenu');
  if (menu && menu.classList.contains('show') && window.bootstrap) window.bootstrap.Collapse.getOrCreateInstance(menu).hide();
  const page = $('.page[data-page="' + name + '"]');
  if (page) $$('.reveal', page).forEach((el) => requestAnimationFrame(() => el.classList.add('in')));
  if (name === 'account') refreshPlan().then(renderAccount);
  if (name === 'pricing') renderPricing();
  if (name === 'tools') refreshPlan().then(renderGuards).then(calcTools);
  renderGuards();
}

function renderGuards() {
  const u = D2C() && D2C().state.user;
  $('#debugLocked').classList.toggle('d-none', !!u);
  $('#debugApp').classList.toggle('d-none', !u);
  $('#accountLocked').classList.toggle('d-none', !!u);
  $('#accountApp').classList.toggle('d-none', !u);
  $('#toolsSignin').classList.toggle('d-none', !!u);
  $('#toolsLocked').classList.toggle('d-none', !u || ex.plan.tools);
  $('#toolsApp').classList.toggle('d-none', !(u && ex.plan.tools));
}

/* --------------------------------------------------------------- Version */
function renderReleases(j) {
  const box = $('#liveReleases');
  if (!box) return;
  const list = (j.history || []).slice(0, 40);
  box.innerHTML = list.map((h, i) => '<article class="tl-item' + (i === 0 ? ' latest' : '') + '"><span class="tl-v">v' + esc(h.version) + (i === 0 ? ' <em>Latest</em>' : '') + '</span><time>' + esc(fmtStamp(h.at)) + '</time><ul><li>' + esc(h.note || 'Improvements and fixes') + '</li></ul></article>').join('');
  $('#liveReleasesHead').classList.toggle('d-none', !list.length);
  const d = $('#relDate');
  if (d) d.textContent = j.at ? '· updated ' + fmtStamp(j.at) : '';
}

/** Compares "2.4.10" with "2.4.9" numerically (so 2.4.10 is higher). */
function cmpVer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

const fmtStamp = (ms) => new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function setVersionText(v, at) {
  $$('[data-version]').forEach((el) => { el.textContent = 'v' + v; el.title = at ? 'Updated ' + fmtStamp(at) : ''; });
  $$('[data-version-date]').forEach((el) => { el.textContent = at ? (el.dataset.versionDate === 'short' ? new Date(at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : fmtStamp(at)) : '—'; });
  $$('.lic-year').forEach((el) => { el.textContent = new Date().getFullYear(); });
}

function initVersion() {
  let loaded = null; // the version this page was opened with
  // Same number everywhere, from the first paint: last known version, else the base in version.json.
  let cached = '', cachedAt = 0; try { cached = localStorage.getItem('d2c_ver') || ''; cachedAt = Number(localStorage.getItem('d2c_ver_at')) || 0; } catch (e) { /* storage blocked */ }
  setVersionText(cached || FALLBACK_VERSION, cachedAt);
  fetch('/version.json', { cache: 'no-store' }).then((r) => r.json()).then((b) => { if (!b || !b.base || loaded) return; const v = b.base + '.' + (b.build || 0), at = Date.parse(b.releasedAt || b.released || '') || 0; if (!cached || cmpVer(v, cached) >= 0) setVersionText(v, at); }).catch(() => {});
  const check = async () => {
    try {
      const r = await fetch('/api/version?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !j.build || j.build === 'unknown') return;
      if (!loaded) {
        loaded = j;
        // The shown version never goes down: if the server ever answers lower than the last one seen, keep the higher.
        const keep = cached && cmpVer(cached, j.version) > 0;
        const shown = keep ? cached : j.version, shownAt = keep ? cachedAt : j.at;
        setVersionText(shown, shownAt);
        try { localStorage.setItem('d2c_ver', shown); localStorage.setItem('d2c_ver_at', String(shownAt || 0)); } catch (e) { /* storage blocked */ }
        renderReleases(j);
        return;
      }
      if (j.build !== loaded.build) {
        $('#updateText').textContent = 'Version v' + j.version + ' is ready' + (j.note ? ': ' + j.note : '.');
        $('#updateBanner').classList.remove('d-none');
        $$('.ver-chip').forEach((el) => el.classList.add('new'));
      }
    } catch (e) { /* offline */ }
  };
  $('#btnReload').addEventListener('click', () => location.reload());
  check();
  setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

/* ------------------------------------------------------------------ Plan */
async function api(path, opts = {}) {
  const token = await D2C().getToken();
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.error || 'Request failed (' + res.status + ').'); e.status = res.status; throw e; }
  return j;
}

async function refreshPlan() {
  if (!D2C() || !D2C().state.user) { ex.plan = { pro: false, mode: 'trial', expiresAt: 0, used: 0, limit: 10, frameworks: ['bootstrap', 'vanilla'] }; renderPlanChip(); return ex.plan; }
  try {
    ex.plan = await api('/api/billing');
  } catch (e) { /* keep previous */ }
  renderPlanChip();
  return ex.plan;
}

function renderPlanChip() {
  const chip = $('#planChip');
  const u = D2C() && D2C().state.user;
  chip.classList.toggle('d-none', !u);
  chip.classList.toggle('pro', !!ex.plan.pro);
  chip.innerHTML = ex.plan.pro || ex.plan.owner ? '<i class="bi bi-gem"></i> ' + esc(tierLabel()) : esc(planName());
  renderQuota();
  applyFrameworkLocks();
}

function renderAccount() {
  const u = D2C() && D2C().state.user;
  if (!u) return;
  $('#acctName').textContent = u.displayName || (u.email || '').split('@')[0] || '—';
  $('#acctEmail').textContent = u.email || '—';
  $('#acctPlan').innerHTML = '<span class="plan-chip' + (ex.plan.pro || ex.plan.owner ? ' pro' : '') + '">' + (ex.plan.pro || ex.plan.owner ? '<i class="bi bi-gem"></i> ' : '') + esc(planName()) + '</span>';
  const tr = ex.plan.trial;
  $('#acctExpLabel').textContent = ex.plan.pro ? 'Active until' : ex.plan.mode === 'expired' ? 'Free trial' : 'Free trial ends';
  $('#acctExpiry').textContent = ex.plan.owner ? 'Never (owner)' : ex.plan.pro ? fmtDate(ex.plan.expiresAt) : (tr ? (tr.active ? fmtDate(tr.endsAt) : 'Ended · subscribe to continue') : '—');
  tickCountdown();
  $('#acctUsed').textContent = ex.plan.used || 0;
  $('#acctLimit').textContent = ex.plan.owner ? '∞' : (ex.plan.limit || 0);
  const pct = ex.plan.limit ? Math.min(100, ((ex.plan.used || 0) / ex.plan.limit) * 100) : 0;
  $('#acctBar').style.width = pct + '%';
  $('#acctReset').textContent = ex.plan.owner ? 'Never needed' : ex.plan.resetAt ? fmtWhen(ex.plan.resetAt) + ' (in ' + fmtLeft(ex.plan.resetAt - Date.now()) + ')' : 'When you use them all, they come back 24 hours later';
  renderSetup();
}

/** Live countdown: a new plan starts at its full length (30 days / 1 year) and counts down every second. */
function tickCountdown() {
  const el = $('#acctCountdown');
  if (!el) return;
  const p = ex.plan || {};
  let end = 0;
  if (p.owner) { el.textContent = 'Unlimited (owner)'; el.classList.remove('low'); return; }
  if (p.pro) end = Number(p.expiresAt) || 0;
  else if (p.trial && p.trial.active) end = Number(p.trial.endsAt) || 0;
  if (!end) { el.textContent = p.mode === 'expired' ? 'Ended' : '—'; el.classList.toggle('low', p.mode === 'expired'); return; }
  const ms = end - Date.now();
  if (ms <= 0) { el.textContent = 'Ended'; el.classList.add('low'); if (!tickCountdown.done) { tickCountdown.done = true; refreshPlan(); } return; }
  tickCountdown.done = false;
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const z = (n) => String(n).padStart(2, '0');
  el.textContent = d + 'd ' + z(h) + 'h ' + z(m) + 'm ' + z(sec) + 's';
  el.classList.toggle('low', ms < 3 * 86400000);
}
setInterval(tickCountdown, 1000);

function renderSetup() {
  const panel = $('#setupPanel');
  const h = ex.plan.owner && ex.plan.setup;
  panel.classList.toggle('d-none', !h);
  if (!h) return;
  const item = (ok, text, fix) => '<li class="' + (ok ? 'ok' : 'bad') + '"><i class="bi ' + (ok ? 'bi-check-circle-fill' : 'bi-x-circle-fill') + '"></i> ' + text + (ok || !fix ? '' : ' <span>' + fix + '</span>') + '</li>';
  $('#setupList').innerHTML = [
    item(h.ai.configured, 'AI provider: <b>' + esc(h.ai.label) + '</b> · low: ' + esc(h.ai.models.low) + ' · standard: ' + esc(h.ai.models.standard) + ' · high: ' + esc(h.ai.models.high), 'Add ' + esc(h.ai.keyName) + ' in Vercel, then redeploy. To use Gemini or ChatGPT instead, add GEMINI_API_KEY or OPENAI_API_KEY and set AI_PROVIDER to gemini or openai.'),
    item(h.database.ok, 'Firestore database reachable by the server', esc(h.database.error)),
    item(!!h.paymongo, 'PayMongo key (' + (h.paymongo === 'live' ? 'LIVE: real money' : h.paymongo === 'test' ? 'TEST mode: no real money yet' : 'missing') + ')', 'Add PAYMONGO_SECRET_KEY (use sk_live_ for real payments).'),
    item(h.paymongo !== 'test', 'Payments are LIVE (sk_live_)', 'Currently a test key. Swap to sk_live_ when ready for real GCash payments.'),
    item(h.webhook, 'PayMongo webhook secret (PAYMONGO_WEBHOOK_SECRET)', 'PayMongo Dashboard, Developers, Webhooks. Event checkout_session.payment.paid.'),
  ].join('') + '<li class="test"><button type="button" class="btn btn-ghost btn-sm" id="btnTestAi"><i class="bi bi-lightning-charge-fill me-1"></i>Test AI now (real request)</button> <span id="aiTestResult"></span></li>';
  $('#btnTestAi').addEventListener('click', testAi);
}

async function testAi() {
  const btn = $('#btnTestAi'), out = $('#aiTestResult');
  btn.disabled = true;
  out.className = '';
  out.textContent = 'Testing all 3 quality levels…';
  try {
    const r = await api('/api/aitest', { method: 'POST', body: '{}' });
    const okAll = r.results.every((x) => x.ok);
    out.className = okAll ? 'ok' : 'bad';
    out.innerHTML = '<br>' + r.results.map((x) => (x.ok ? '<i class="bi bi-check-circle-fill"></i> ' : '<i class="bi bi-x-circle-fill"></i> ') + '<b>' + esc(x.quality) + '</b> · ' + esc(x.model) + (x.ok ? ' · ' + x.ms + ' ms · "' + esc(x.reply) + '"' : ' · ' + esc(x.error))).join('<br>');
  } catch (e) {
    out.className = 'bad';
    out.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function setPayStatus(kind, html) {
  const el = $('#payStatus');
  el.className = 'alert glass-alert ' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '');
  el.innerHTML = html;
  el.classList.toggle('d-none', !html);
}

async function verifyPayment(showErrors) {
  const sessionId = localStorage.getItem('d2c:pendingSession') || '';
  setPayStatus('', '<span class="spinner-border spinner-border-sm me-2"></span>Confirming your GCash payment…');
  try {
    const r = await api('/api/billing', { method: 'POST', body: JSON.stringify(sessionId ? { sessionId } : {}) });
    if (r.paid) {
      localStorage.removeItem('d2c:pendingSession');
      await refreshPlan();
      renderAccount();
      setPayStatus('ok', '<i class="bi bi-check-circle-fill me-2"></i>Thank you! Your <b>' + esc(tierLabel()) + '</b> plan is active until ' + fmtDate(r.expiresAt) + '.');
      toast('Your plan is active. Thank you!', 'ok', 6000);
    } else {
      setPayStatus('', esc(r.message || 'The payment is not completed yet.') + ' If you already paid with GCash, press <b>Check payment</b> again in a few seconds.');
    }
  } catch (e) {
    setPayStatus('err', '<i class="bi bi-exclamation-triangle-fill me-2"></i>' + esc(e.message));
  }
}

/* --------------------------------------------------------------- Pricing */
function tierLabel() { if (ex.plan.owner) return 'Owner'; const t = ex.tiers[ex.plan.tier]; return t ? t.label : 'Pro'; }
/** Name of the plan the user is on right now (shown in chips and the account page). */
function planName() { return ex.plan.pro || ex.plan.owner ? tierLabel() : ex.plan.mode === 'expired' ? 'Trial ended' : 'Free trial'; }

const fmtWhen = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function fmtLeft(ms) { const m = Math.max(1, Math.ceil(ms / 60000)); return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }

/** "7 of 10 generations left" under the Generate button. */
function renderQuota() {
  const el = $('#genQuota');
  if (!el) return;
  const u = D2C() && D2C().state.user;
  if (!u) { el.textContent = ''; return; }
  const p = ex.plan;
  if (p.owner) { el.innerHTML = '<i class="bi bi-infinity"></i> Unlimited generations (owner)'; return; }
  const left = Math.max(0, (p.limit || 0) - (p.used || 0));
  let t = '<b>' + left + '</b> of ' + (p.limit || 0) + ' generations left';
  if (left === 0 && p.resetAt) t += ' · back in <b>' + fmtLeft(p.resetAt - Date.now()) + '</b> (' + esc(fmtWhen(p.resetAt)) + ')';
  else if (p.mode === 'expired') t = '<i class="bi bi-lock-fill"></i> Your 7-day free trial has ended · <a href="#/pricing">Subscribe to continue</a>';
  else if (p.mode === 'trial' && p.trial && p.trial.endsAt) t += ' · trial ends ' + esc(fmtWhen(p.trial.endsAt));
  el.classList.toggle('empty', left === 0);
  el.innerHTML = t;
}

/** Locks the output options the user's plan does not include. */
function applyFrameworkLocks() {
  const allowed = ex.plan.frameworks;
  const radios = $$('input[name="framework"]');
  if (!allowed || !radios.length) return;
  radios.forEach((r) => {
    const ok = allowed.includes(r.value);
    r.disabled = !ok;
    const row = r.closest('.opt-row');
    if (row) { row.classList.toggle('locked', !ok); row.title = ok ? '' : 'Not included in your plan'; }
  });
  const cur = radios.find((r) => r.checked);
  if (cur && cur.disabled) { const first = radios.find((r) => !r.disabled); if (first) { first.checked = true; first.dispatchEvent(new Event('change', { bubbles: true })); } }
}

function pricing() {
  const t = ex.tiers.pro; // ROI / tools compare against the Pro tier
  const { monthly, yearly } = t;
  return { monthly, yearly, price: ex.period === 'yearly' ? yearly : monthly, per: ex.period === 'yearly' ? '/ year' : '/ 30 days' };
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (j.tiers) ex.tiers = { ...ex.tiers, ...j.tiers };
    if (j.free) ex.free = j.free;
    ex.cfg = { payments: !!j.payments, live: !!j.paymentsLive };
  } catch (e) { /* keep defaults */ }
  renderPricing();
}

function specHtml(t) {
  if (!t || !t.quality) return '';
  const n = { basic: 1, low: 1, standard: 2, high: 3 }[t.quality] || 1;
  const th = t.then;
  const k = (x) => Math.round(x.outputTokens / 1000);
  return '<div><dt>AI quality</dt><dd title="' + esc(t.blurb || '') + '"><span class="q-bars q-' + esc(t.quality) + '"><i class="on"></i><i class="' + (n > 1 ? 'on' : '') + '"></i><i class="' + (n > 2 ? 'on' : '') + '"></i></span> <b>' + esc(t.qualityLabel) + (th ? ' → ' + esc(th.qualityLabel) : '') + '</b></dd></div>'
    + '<div><dt>Speed</dt><dd>' + esc(t.speed) + '</dd></div>'
    + '<div><dt>Max output</dt><dd>~' + k(t) + 'K' + (th ? ' → ~' + k(th) + 'K' : '') + ' tokens</dd></div>'
    + '<div class="plan-blurb">' + esc(t.blurb || '') + (th ? ' After the 7-day trial: ' + esc(th.blurb) : '') + '</div>';
}

function renderPricing() {
  Object.entries({ free: ex.free, ...ex.tiers }).forEach(([k, t]) => { const el = $('[data-spec="' + k + '"]'); if (el) el.innerHTML = specHtml(t); });
  const per = ex.period === 'yearly' ? '/ year' : '/ 30 days';
  Object.entries(ex.tiers).forEach(([k, t]) => {
    const price = $('[data-price="' + k + '"]'), gens = $('[data-gens="' + k + '"]');
    if (price) { price.textContent = '₱' + (ex.period === 'yearly' ? t.yearly : t.monthly).toLocaleString('en-PH'); price.nextElementSibling.textContent = per; }
    if (gens) gens.textContent = t.gens;
  });
  const p = ex.tiers.pro;
  const save = Math.round((1 - p.yearly / ((p.monthly * 365) / 30)) * 100);
  $('.save-tag').textContent = save > 0 ? 'Save up to ' + save + '%' : '';
  $$('.billing-toggle[aria-label="Billing period"] button').forEach((b) => b.classList.toggle('active', b.dataset.period === ex.period));
  const signed = D2C() && D2C().state.user;
  $$('.btn-buy').forEach((btn) => {
    const same = ex.plan.pro && ex.plan.tier === btn.dataset.tier;
    btn.querySelector('span').textContent = !signed ? 'Sign in to subscribe' : same ? 'Renew / extend' : 'Pay with GCash';
  });
  $('#buyHint').textContent = ex.plan.owner ? 'Owner account: full access, no payment needed'
    : ex.plan.pro ? tierLabel() + ' active until ' + fmtDate(ex.plan.expiresAt)
    : !ex.cfg.payments ? 'Payments are not set up yet. Please check back soon.'
    : ex.cfg.live ? 'Real payment via PayMongo · GCash · no auto-renewal'
    : 'TEST MODE: no real money is charged yet · GCash via PayMongo';
  calcRoi();
}

async function buyPro(tier) {
  const err = $('#buyError');
  err.classList.add('d-none');
  if (!D2C().state.user) { D2C().openAuth('login'); return; }
  const btns = $$('.btn-buy');
  btns.forEach((b) => { b.disabled = true; });
  try {
    const r = await api('/api/checkout', { method: 'POST', body: JSON.stringify({ plan: tier + '_' + ex.period }) });
    localStorage.setItem('d2c:pendingSession', r.id);
    location.href = r.url;
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('d-none');
    btns.forEach((b) => { b.disabled = false; });
  }
}

function calcRoi() {
  const hours = +$('#roiHours').value, pages = +$('#roiPages').value, rate = +$('#roiRate').value, saved = +$('#roiSaved').value;
  $('#roiHoursV').textContent = hours; $('#roiPagesV').textContent = pages; $('#roiRateV').textContent = rate; $('#roiSavedV').textContent = saved;
  const hrsSaved = hours * pages * (saved / 100);
  const value = hrsSaved * rate;
  const cost = pricing().monthly; // compare against one month of Pro
  const roi = ((value - cost) / cost) * 100;
  $('#roiOut1').textContent = hrsSaved.toFixed(1) + ' hrs';
  $('#roiOut2').textContent = peso(value);
  $('#roiOut3').textContent = peso(cost);
  $('#roiOut4').textContent = (roi >= 0 ? '+' : '') + Math.round(roi).toLocaleString() + '%';
  const payback = value > 0 ? (cost / value) * 30 : 0;
  $('#roiNote').textContent = value > cost
    ? 'With your numbers, the ' + peso(cost) + ' cost is earned back in about ' + Math.max(1, Math.ceil(payback)) + ' day(s). Everything after that is extra income or free time.'
    : 'With these numbers Pro does not pay for itself yet. Increase the pages per month or the value of your time to see the effect.';
}

function initPricing() {
  $$('.billing-toggle[aria-label="Billing period"] button').forEach((b) => b.addEventListener('click', () => { ex.period = b.dataset.period; renderPricing(); }));
  $$('.btn-buy').forEach((b) => b.addEventListener('click', () => buyPro(b.dataset.tier)));
  $$('#roi input[type=range]').forEach((i) => i.addEventListener('input', calcRoi));
  $('#btnCheckPay').addEventListener('click', () => verifyPayment(true));
  calcRoi();
}

/* ------------------------------------------------------------- Debugger */
function md(text) {
  // tiny, safe markdown: fenced code, inline code, bold, numbered/bulleted lines
  const parts = String(text).split(/```/);
  return parts.map((seg, i) => {
    if (i % 2) {
      const nl = seg.indexOf('\n');
      const lang = nl > -1 ? seg.slice(0, nl).trim() : '';
      const code = nl > -1 ? seg.slice(nl + 1) : seg;
      return '<div class="code-block"><div class="cb-top"><span>' + esc(lang || 'code') + '</span><button type="button" class="cb-copy">Copy</button></div><pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre></div>';
    }
    return esc(seg)
      .replace(/^#{1,6}\s+(.+)$/gm, '<strong class="md-h">$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s).,!?:;])/gm, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/^\s*(\d+)\.\s+(.*)$/gm, '<div class="md-li"><span>$1.</span><div>$2</div></div>')
      .replace(/^\s*[-•]\s+(.*)$/gm, '<div class="md-li"><span>•</span><div>$1</div></div>')
      .replace(/\n{2,}/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }).join('');
}

function addMsg(role, text) {
  $('#chatEmpty')?.remove();
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.innerHTML = '<div class="msg-av">' + (role === 'user' ? '<i class="bi bi-person-fill"></i>' : '<i class="bi bi-stars"></i>') + '</div><div class="msg-body"></div>';
  const body = el.querySelector('.msg-body');
  if (role === 'user') body.textContent = text; else body.innerHTML = md(text);
  $('#chatLog').appendChild(el);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  return body;
}

function setBusy(on) {
  $('#chatSend').classList.toggle('d-none', on);
  $('#chatStop').classList.toggle('d-none', !on);
  $('#dbgExplain').disabled = on;
  $('#chatInput').disabled = on;
}

async function ask(question) {
  if (ex.busy) return;
  question = question.trim();
  if (!question) return;
  if (!D2C().state.user) return D2C().openAuth('login');
  ex.chat.push({ role: 'user', content: question });
  addMsg('user', question);
  const body = addMsg('assistant', '');
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  setBusy(true);
  ex.busy = new AbortController();
  let out = '';
  try {
    const token = await D2C().getToken();
    const res = await fetch('/api/debug', {
      method: 'POST',
      signal: ex.busy.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ messages: ex.chat, error: $('#dbgError').value, code: $('#dbgCode').value }),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Debugger failed (' + res.status + ').'); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      const clean = out.split('[[D2C_ERROR]]')[0];
      body.innerHTML = md(clean);
      $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
    }
    const m = out.split('[[D2C_ERROR]]');
    if (m[1]) throw new Error(m[1].trim());
    ex.chat.push({ role: 'assistant', content: out });
  } catch (e) {
    if (e.name === 'AbortError') { if (out) ex.chat.push({ role: 'assistant', content: out }); else ex.chat.pop(); body.innerHTML = out ? md(out) + '<div class="small text-secondary mt-2">Stopped.</div>' : '<span class="text-secondary">Stopped.</span>'; }
    else { ex.chat.pop(); body.innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-triangle-fill me-1"></i>' + esc(e.message) + '</span>'; }
  } finally {
    setBusy(false);
    ex.busy = null;
    $('#chatInput').focus();
  }
}

function initDebugger() {
  $('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#chatInput').value; $('#chatInput').value = ''; autosize(); ask(v); });
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); } });
  $('#chatInput').addEventListener('input', autosize);
  $('#chatStop').addEventListener('click', () => ex.busy && ex.busy.abort());
  $('#dbgExplain').addEventListener('click', () => {
    if (!$('#dbgError').value.trim() && !$('#dbgCode').value.trim()) return toast('Add an error message or some code first.', 'info');
    ask('Why does this error happen and how do I fix it?');
  });
  $('#dbgClear').addEventListener('click', () => { $('#dbgError').value = ''; $('#dbgCode').value = ''; ex.chat = []; $('#chatLog').innerHTML = ''; });
  $('#dbgUseProject').addEventListener('click', () => useProjectCode(true));
  $('#chatLog').addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]');
    if (q) { $('#chatInput').value = q.dataset.q; $('#chatForm').requestSubmit(); return; }
    const c = e.target.closest('.cb-copy');
    if (c) {
      const code = c.closest('.code-block').querySelector('code').textContent;
      navigator.clipboard.writeText(code).then(() => { c.textContent = 'Copied'; setTimeout(() => (c.textContent = 'Copy'), 1500); }).catch(() => toast('Press Ctrl+C to copy.', 'info'));
    }
  });
}

function autosize() {
  const t = $('#chatInput');
  t.style.height = 'auto';
  t.style.height = Math.min(140, t.scrollHeight) + 'px';
}

function useProjectCode(notify) {
  const cur = D2C().state.current;
  if (!cur || !cur.files.length) { if (notify) toast('No project is open in the Studio.', 'info'); return false; }
  $('#dbgCode').value = cur.files.map((f) => '===FILE: ' + f.name + '===\n' + f.content).join('\n').slice(0, 60000);
  return true;
}

/* --------------------------------- Error capture (preview + app events) */
function offerDebug(message) {
  ex.lastError = String(message || '').slice(0, 4000);
  if (!ex.lastError) return;
  const el = document.createElement('div');
  el.className = 'toast align-items-start border-0 err';
  el.setAttribute('role', 'alert');
  el.innerHTML = '<div class="toast-body"><i class="bi bi-bug-fill"></i><div class="flex-grow-1"><div class="small mb-2"></div><button class="btn btn-sm btn-brand" type="button">Explain this error</button></div><button type="button" class="btn-close btn-sm" data-bs-dismiss="toast" aria-label="Close"></button></div>';
  el.querySelector('.small').textContent = ex.lastError.slice(0, 160);
  $('#toasts').appendChild(el);
  const t = new window.bootstrap.Toast(el, { delay: 12000 });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  el.querySelector('.btn-brand').addEventListener('click', () => { t.hide(); openDebugWith(ex.lastError); });
  t.show();
}

function openDebugWith(message) {
  $('#dbgError').value = message;
  useProjectCode(false);
  location.hash = '#/debug';
  setTimeout(() => { if (D2C().state.user) ask('Why does this error happen and how do I fix it?'); }, 150);
}

let lastSeen = '';
function initErrorCapture() {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.d2c !== 'error') return;
    const msg = d.message + (d.line ? ' (line ' + d.line + ')' : '') + (d.stack ? '\n' + d.stack : '');
    if (msg === lastSeen) return;
    lastSeen = msg;
    offerDebug('Preview error: ' + msg);
  });
  window.addEventListener('d2c:error', (e) => offerDebug(e.detail && e.detail.message));
  window.addEventListener('d2c:upgrade', (e) => {
    const d = e.detail || {};
    if (d.reason === 'limit' && d.resetAt) {
      // Out of generations: stay in the Studio, say exactly when they come back.
      toast(d.message + ' (' + fmtWhen(d.resetAt) + ' your time)', 'info', 10000);
      refreshPlan();
      return;
    }
    toast(d.message || 'Subscribe to a plan to continue.', 'info', 8000);
    location.hash = '#/pricing';
  });
  window.addEventListener('d2c:genend', () => { refreshPlan(); });
  window.addEventListener('error', (e) => { if (e.filename && /\/assets\//.test(e.filename)) offerDebug('App error: ' + e.message); });
}


/* ------------------------------------------------------------ Pro Tools */
const num = (id) => Math.max(0, parseFloat($(id).value) || 0);

function calcBusinessRoi() {
  const price = num('#brPrice'), sites = num('#brSites'), hand = num('#brHand'), ai = num('#brAi'), rate = num('#brRate');
  const cost = pricing().monthly;
  const hoursSaved = Math.max(0, (hand - ai) * sites);
  const value = hoursSaved * rate;
  const net = value - cost;
  const capacity = ai > 0 ? Math.floor((hand * sites) / ai) : 0;
  const roi = cost > 0 ? (net / cost) * 100 : 0;
  $('#brOut1').textContent = hoursSaved.toFixed(1) + ' hrs';
  $('#brOut2').textContent = peso(value);
  $('#brOut3').textContent = peso(cost);
  $('#brOut4').textContent = (net < 0 ? '-' : '') + peso(Math.abs(net));
  $('#brOut5').textContent = ai > 0 ? capacity + ' sites' : '—';
  $('#brOut6').textContent = (roi >= 0 ? '+' : '') + Math.round(roi).toLocaleString() + '%';
  const extra = Math.max(0, capacity - sites) * price;
  $('#brNote').textContent = net > 0
    ? 'Your time savings are worth ' + peso(value) + ' a month, which is ' + peso(net) + ' more than Pro costs. If you used the saved hours to sell more websites at ' + peso(price) + ' each, the extra revenue could reach about ' + peso(extra) + ' a month. This is an estimate, not a guarantee.'
    : 'With these numbers the saved time is worth less than Pro costs. Check the hours per website with and without AI, or the number of websites you sell.';
}

// Graduated income tax table (TRAIN Law) for individuals, annual.
function graduatedTax(n) {
  if (n <= 250000) return 0;
  if (n <= 400000) return (n - 250000) * 0.15;
  if (n <= 800000) return 22500 + (n - 400000) * 0.2;
  if (n <= 2000000) return 102500 + (n - 800000) * 0.25;
  if (n <= 8000000) return 402500 + (n - 2000000) * 0.3;
  return 2202500 + (n - 8000000) * 0.35;
}

function calcBirTax() {
  const gross = num('#taxGross'), exp = Math.min(num('#taxExp'), gross), mixed = $('#taxType').value === 'mixed';
  const warn = $('#taxWarn');
  const opts = [];
  const over = gross > 3000000;
  opts.push({
    key: '8%', title: '8% flat income tax', sub: mixed ? '8% of gross receipts (no ₱250,000 reduction for mixed income)' : '8% of gross receipts above ₱250,000',
    income: over ? null : Math.max(0, gross - (mixed ? 0 : 250000)) * 0.08, pct: 0, na: over ? 'Not available above ₱3,000,000 gross' : '',
  });
  const pt = over ? 0 : gross * 0.03; // above ₱3,000,000 VAT applies instead of the 3% percentage tax
  opts.push({ key: 'osd', title: 'Graduated + 40% standard deduction', sub: over ? 'Taxable income = 60% of gross (VAT applies instead of percentage tax)' : 'Taxable income = 60% of gross, plus 3% percentage tax', income: graduatedTax(gross * 0.6), pct: pt });
  opts.push({ key: 'item', title: 'Graduated + itemized expenses', sub: over ? 'Taxable income = gross minus actual expenses (VAT applies instead of percentage tax)' : 'Taxable income = gross minus actual expenses, plus 3% percentage tax', income: graduatedTax(Math.max(0, gross - exp)), pct: pt });
  opts.forEach((o) => { o.total = o.income == null ? Infinity : o.income + o.pct; });
  const best = opts.reduce((a, b) => (b.total < a.total ? b : a), opts[0]);
  $('#taxOptions').innerHTML = opts.map((o) => {
    if (o.income == null) return '<div class="tax-opt na"><div><b>' + esc(o.title) + '</b><small>' + esc(o.na) + '</small></div></div>';
    const left = gross - exp - o.total;
    return '<div class="tax-opt' + (o === best ? ' best' : '') + '">' +
      '<div class="to-head"><div><b>' + esc(o.title) + '</b><small>' + esc(o.sub) + '</small></div>' + (o === best ? '<span class="best-tag">Lowest tax</span>' : '') + '</div>' +
      '<div class="to-grid"><div><small>Income tax</small><b>' + peso(o.income) + '</b></div><div><small>' + (over ? 'Percentage tax (VAT applies)' : 'Percentage tax (3%)') + '</small><b>' + peso(o.pct) + '</b></div>' +
      '<div><small>Total tax</small><b>' + peso(o.total) + '</b></div><div><small>Left after expenses and tax</small><b>' + peso(left) + '</b></div></div>' +
      '<div class="to-eff">' + (gross ? ((o.total / gross) * 100).toFixed(1) : '0.0') + '% of gross receipts</div></div>';
  }).join('');
  warn.classList.toggle('d-none', !over);
  if (over) warn.textContent = 'Gross receipts above ₱3,000,000 mean you are no longer eligible for the 8% option and VAT registration applies. The 3% percentage tax no longer applies, and the 12% VAT is not included in these numbers.';
  $('#taxNote').textContent = gross === 0 ? 'Enter your gross receipts to see the estimate.' : 'Best for these numbers: ' + best.title + ' (about ' + peso(best.total) + ' a year). Compare again if your expenses change, and confirm your choice with the BIR or a tax professional.';
}

function calcTools() {
  calcBusinessRoi();
  calcBirTax();
}

function initTools() {
  $$('#toolsApp input, #toolsApp select').forEach((i) => i.addEventListener('input', calcTools));
  $$('.billing-toggle[aria-label="Tool"] button').forEach((b) => b.addEventListener('click', () => {
    $$('.billing-toggle[aria-label="Tool"] button').forEach((x) => x.classList.toggle('active', x === b));
    $('#toolRoi').classList.toggle('d-none', b.dataset.tool !== 'roi');
    $('#toolBir').classList.toggle('d-none', b.dataset.tool !== 'bir');
  }));
  calcTools();
}

/* ------------------------------------------------------------ Assistant */
const ast = { chat: [], busy: null, uid: null };

function astAdd(role, text) {
  const el = document.createElement('div');
  el.className = 'ast-msg ' + role;
  el.setAttribute('dir', 'auto'); // right-to-left languages (Arabic, Hebrew, Urdu...) display correctly
  if (role === 'user') el.textContent = text; else el.innerHTML = md(text);
  $('#astLog').appendChild(el);
  $('#astLog').scrollTop = $('#astLog').scrollHeight;
  return el;
}

function astWelcome() {
  $('#astLog').innerHTML = '';
  const u = D2C() && D2C().state.user;
  astAdd('assistant', u
    ? 'Hi! I am your DRAW2CODE AI assistant. Ask me anything, in any language: questions, code, writing, ideas, or help with plans, payments and how to use the system.'
    : 'Hi! Please sign in first so we can chat. Then you can ask me anything, in any language.');
  ast.chat = [];
  $('#astChips').classList.remove('d-none');
}

function astOpen(open) {
  $('#astPanel').classList.toggle('d-none', !open);
  $('#astFab').classList.toggle('d-none', open);
  $('#astFab').setAttribute('aria-expanded', String(open));
  if (open) { if (!$('#astLog').children.length) astWelcome(); $('#astInput').focus(); }
}

async function astAsk(q) {
  q = q.trim();
  if (!q || ast.busy) return;
  if (!D2C() || !D2C().state.user) { astAdd('assistant', 'Please sign in first so I can help you.'); astOpen(false); D2C() && D2C().openAuth('login'); return; }
  $('#astChips').classList.add('d-none');
  ast.chat.push({ role: 'user', content: q });
  astAdd('user', q);
  const body = astAdd('assistant', '');
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  ast.busy = new AbortController();
  $('#astSend').disabled = true;
  let out = '';
  try {
    const token = await D2C().getToken();
    const res = await fetch('/api/assistant', {
      method: 'POST',
      signal: ast.busy.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ messages: ast.chat }),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'The assistant failed (' + res.status + ').'); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      body.innerHTML = md(out.split('[[D2C_ERROR]]')[0]);
      $('#astLog').scrollTop = $('#astLog').scrollHeight;
    }
    const m = out.split('[[D2C_ERROR]]');
    if (m[1]) throw new Error(m[1].trim());
    if (!out.trim()) throw new Error('The assistant did not return an answer. Please try again.');
    ast.chat.push({ role: 'assistant', content: out });
  } catch (e) {
    ast.chat.pop();
    body.innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-triangle-fill me-1"></i>' + esc(e.message) + '</span>';
  } finally {
    ast.busy = null;
    $('#astSend').disabled = false;
    $('#astInput').focus();
  }
}

function initAssistant() {
  $('#astFab').addEventListener('click', () => astOpen(true));
  $('#astClose').addEventListener('click', () => astOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#astPanel').classList.contains('d-none')) astOpen(false); });
  $('#astForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#astInput').value; $('#astInput').value = ''; $('#astInput').style.height = ''; astAsk(v); });
  $('#astInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#astForm').requestSubmit(); } });
  $('#astInput').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 110) + 'px'; });
  $('#astChips').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) astAsk(b.dataset.q); });
  window.addEventListener('d2c:auth', (e) => {
    const uid = e.detail.user ? e.detail.user.uid : null;
    if (uid !== ast.uid) { ast.uid = uid; if (ast.busy) ast.busy.abort(); if ($('#astLog').children.length) astWelcome(); }
  });
}

/* ------------------------------------------------------------------ Boot */
function init() {
  initVersion();
  initPricing();
  initTools();
  initDebugger();
  initAssistant();
  initErrorCapture();
  window.addEventListener('hashchange', route);
  window.addEventListener('d2c:auth', async (e) => {
    const user = e.detail.user;
    if (user && currentRoute() === 'login') location.hash = '#/studio';
    try {
      renderGuards();
      await refreshPlan();
      renderGuards();
      renderPricing();
      renderAccount();
    } catch (err) { console.error(err); }
    if (user && /paid=1/.test(location.hash)) { location.hash = '#/account?paid=1'; verifyPayment(false); }
  });
  route();
  loadConfig();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
