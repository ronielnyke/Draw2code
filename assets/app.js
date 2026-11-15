// DRAW2CODE AI — main application (ES module, no build step).
import { FRAMEWORKS, INPUT_TYPES, parseFiles, buildPreview, slugify, fmtBytes, totalBytes, escapeHtml, makeZip } from './lib.js';

const FB = 'https://www.gstatic.com/firebasejs/11.0.2/';
// Public web config of the Firebase project "raw2code" (not a secret; protected by Auth + Firestore rules).
// Used as a fallback so sign-in still works even if /api/config cannot be reached.
const FB_DEFAULT = {
  apiKey: 'AIzaSyDO0WT9GJBbW01AIVCgACglvaN0g3U4WsA',
  authDomain: 'raw2code.firebaseapp.com',
  projectId: 'raw2code',
  storageBucket: 'raw2code.firebasestorage.app',
  messagingSenderId: '246249703811',
  appId: '1:246249703811:web:4141fdbe17139407138eb6',
};
const MAX_DOC_BYTES = 900 * 1024;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = {
  fb: null, // firebase modules
  auth: null,
  db: null,
  user: null,
  unsub: null,
  projects: [],
  current: null, // { id, name, framework, inputType, files, version, createdAt }
  image: null, // { data, thumb, w, h }  (full compressed dataURL + thumbnail)
  activeFile: 0,
  pane: 'preview',
  device: 'desktop',
  generating: false,
  abort: null,
  dirty: false,
  saving: false,
  online: navigator.onLine,
  fromCache: false,
  pendingWrites: false,
  configured: false,
  aiReady: true,
  authMode: 'login',
  settings: { framework: 'bootstrap', inputType: 'screenshot' },
};

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */
function toast(msg, type = 'info', ms = 4200) {
  const icons = { ok: 'bi-check-circle-fill', err: 'bi-exclamation-triangle-fill', info: 'bi-info-circle-fill' };
  const el = document.createElement('div');
  el.className = 'toast align-items-start border-0 ' + type;
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  el.innerHTML = '<div class="toast-body"><i class="bi ' + icons[type] + '"></i><div class="flex-grow-1"></div><button type="button" class="btn-close btn-sm" data-bs-dismiss="toast" aria-label="Close"></button></div>';
  el.querySelector('.flex-grow-1').textContent = msg;
  $('#toasts').appendChild(el);
  const t = new window.bootstrap.Toast(el, { delay: ms });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  t.show();
}

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}
function lsSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch (e) {
    return false;
  }
}

function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

function modal(id) {
  return window.bootstrap.Modal.getOrCreateInstance($(id));
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function radioValue(name) {
  const el = $('input[name="' + name + '"]:checked');
  return el ? el.value : null;
}
function setRadio(name, value) {
  const el = $('input[name="' + name + '"][value="' + value + '"]');
  if (el) el.checked = true;
}

/* ------------------------------------------------------------------ */
/* Theme, nav, reveal                                                  */
/* ------------------------------------------------------------------ */
function initChrome() {
  $('#year').textContent = new Date().getFullYear();

  const applyThemeIcon = () => {
    const light = document.documentElement.getAttribute('data-bs-theme') === 'light';
    $('#themeToggle i').className = 'bi ' + (light ? 'bi-sun' : 'bi-moon-stars');
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', light ? '#f5f6fc' : '#070a14');
  };
  applyThemeIcon();
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-bs-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-bs-theme', next);
    try { localStorage.setItem('d2c:theme', next); } catch (e) { /* ignore */ }
    applyThemeIcon();
  });

  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 16);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // close mobile menu after clicking a link
  $$('#navMenu a.nav-link').forEach((a) => a.addEventListener('click', () => {
    const c = $('#navMenu');
    if (c.classList.contains('show')) window.bootstrap.Collapse.getOrCreateInstance(c).hide();
  }));

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' })
    : null;
  $$('.reveal').forEach((el) => (io ? io.observe(el) : el.classList.add('in')));
}

/* ------------------------------------------------------------------ */
/* Firebase boot                                                       */
/* ------------------------------------------------------------------ */
function showSetupError(html) {
  const el = $('#setupAlert');
  el.innerHTML = html;
  el.classList.remove('d-none');
}

async function bootFirebase() {
  let cfg;
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    cfg = r.ok && j && j.firebase ? j : { firebase: FB_DEFAULT, ai: true };
  } catch (e) {
    cfg = { firebase: FB_DEFAULT, ai: true };
  }
  state.aiReady = cfg.ai !== false;
  if (!state.aiReady) showSetupError('<strong>AI is not configured.</strong> Add <code>' + (cfg.aiKey || 'ANTHROPIC_API_KEY') + '</code> in Vercel environment variables and redeploy. Saving and editing still work.');

  try {
    const [app, auth, fs] = await Promise.all([
      import(FB + 'firebase-app.js'),
      import(FB + 'firebase-auth.js'),
      import(FB + 'firebase-firestore.js'),
    ]);
    const fbApp = app.getApps().length ? app.getApp() : app.initializeApp(cfg.firebase);
    state.auth = auth.getAuth(fbApp);
    try {
      state.db = fs.initializeFirestore(fbApp, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
      });
    } catch (e) {
      state.db = fs.getFirestore(fbApp);
    }
    state.fb = { ...auth, ...fs };
    state.configured = true;
  } catch (e) {
    console.error(e);
    showSetupError('<strong>Could not load Firebase.</strong> Check your connection and reload the page.');
    return;
  }

  state.fb.onAuthStateChanged(state.auth, onAuthChanged, (err) => {
    console.error(err);
    toast('Authentication error. Please reload the page.', 'err');
  });
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */
function authError(e) {
  const map = {
    'auth/invalid-email': 'That email address is not valid.',
    'auth/missing-password': 'Please enter your password.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/email-already-in-use': 'An account with this email already exists. Try signing in.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/user-not-found': 'Incorrect email or password.',
    'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/popup-closed-by-user': 'The sign-in window was closed.',
    'auth/cancelled-popup-request': 'The sign-in window was closed.',
    'auth/unauthorized-domain': 'This domain is not authorized in Firebase. Add it under Authentication → Settings → Authorized domains.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled in Firebase Authentication.',
    'auth/user-disabled': 'This account has been disabled.',
  };
  return map[e && e.code] || (e && e.message) || 'Something went wrong. Please try again.';
}

function setAuthMsg(kind, msg) {
  const err = $('#authError');
  const info = $('#authInfo');
  err.classList.add('d-none');
  info.classList.add('d-none');
  if (!msg) return;
  const el = kind === 'err' ? err : info;
  el.textContent = msg;
  el.classList.remove('d-none');
}

/* ---- Password UI: show/hide eye, strength meter, confirm-match indicator ---- */
const PW_LEVELS = ['', 'Weak', 'Fair', 'Good', 'Strong'];

function passStrength(p) {
  const checks = { len: p.length >= 8, case: /[a-z]/.test(p) && /[A-Z]/.test(p), num: /\d/.test(p), sym: /[^A-Za-z0-9]/.test(p) };
  if (!p) return { level: 0, label: '', checks, note: '' };
  const common = /^(password|passw0rd|qwerty|123456|12345678|111111|abc123|iloveyou|admin|letmein|welcome|draw2code)/i.test(p) || /^(.)\1+$/.test(p);
  let pts = Object.values(checks).filter(Boolean).length + (p.length >= 12 ? 1 : 0);
  if (!checks.len) return { level: 1, label: 'Too short', checks, note: 'Use at least 8 characters.' };
  if (common) return { level: 1, label: 'Too common', checks, note: 'That password is easy to guess.' };
  const level = pts <= 2 ? 1 : pts === 3 ? 2 : pts === 4 ? 3 : 4;
  return { level, label: PW_LEVELS[level], checks, note: level >= 4 ? 'Great, this is a strong password.' : level >= 2 ? 'Add 12+ characters, symbols or numbers to make it stronger.' : 'Mix upper/lower case, numbers and symbols.' };
}

function updatePwUi() {
  const reg = state.authMode === 'register';
  const pass = $('#authPass').value, pass2 = $('#authPass2').value;
  const st = passStrength(pass);
  $('#pwMeter').dataset.level = String(st.level);
  $$('#pwMeter span').forEach((seg, i) => seg.classList.toggle('on', i < st.level));
  $('#pwLabel').innerHTML = pass ? '<b>' + st.label + '</b> · ' + st.note : 'Use 8+ characters with letters, numbers and symbols.';
  $('#pwLabel').dataset.level = String(st.level);
  $$('#pwChecks li').forEach((li) => {
    const ok = !!st.checks[li.dataset.check];
    li.classList.toggle('ok', ok);
    li.querySelector('i').className = 'bi ' + (ok ? 'bi-check-circle-fill' : 'bi-circle');
  });
  const m = $('#pwMatch'), c = $('#authPass2');
  c.classList.remove('pw-ok', 'pw-bad');
  if (!reg || !pass2) { m.textContent = ''; m.className = 'pw-match'; return; }
  const same = pass === pass2;
  c.classList.add(same ? 'pw-ok' : 'pw-bad');
  m.className = 'pw-match ' + (same ? 'ok' : 'bad');
  m.innerHTML = same ? '<i class="bi bi-check-circle-fill"></i> Passwords match' : '<i class="bi bi-x-circle-fill"></i> Passwords do not match';
}

function resetPwUi() {
  $$('.pw-eye').forEach((b) => {
    const input = $('#' + b.dataset.target);
    if (input) input.type = 'password';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', 'Show password');
    b.firstElementChild.className = 'bi bi-eye';
  });
  updatePwUi();
}

function initPwUi() {
  $$('.pw-eye').forEach((b) => b.addEventListener('click', () => {
    const input = $('#' + b.dataset.target);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.setAttribute('aria-pressed', String(show));
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    b.firstElementChild.className = 'bi ' + (show ? 'bi-eye-slash' : 'bi-eye');
    input.focus();
  }));
  $('#authPass').addEventListener('input', updatePwUi);
  $('#authPass2').addEventListener('input', updatePwUi);
  updatePwUi();
}

function setAuthMode(mode) {
  state.authMode = mode;
  const reg = mode === 'register';
  $('#tabLogin').classList.toggle('active', !reg);
  $('#tabRegister').classList.toggle('active', reg);
  $('#nameRow').classList.toggle('d-none', !reg);
  $('#strengthRow').classList.toggle('d-none', !reg);
  $('#confirmRow').classList.toggle('d-none', !reg);
  $('#btnForgot').parentElement.classList.toggle('d-none', reg);
  $('#btnAuthSubmit').textContent = reg ? 'Create account' : 'Sign in';
  $('#authPass').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
  setAuthMsg(null);
  resetPwUi();
}

function openAuth(mode = 'login') {
  if (!state.configured) {
    toast('The app is not configured yet. See the setup message in the Studio section.', 'err');
    location.hash = '#/studio';
    return;
  }
  setAuthMode(mode);
  if (location.hash !== '#/login') location.hash = '#/login';
}

function afterLogin() {
  const f = $('#authForm');
  if (f) f.reset();
  resetPwUi();
  if (location.hash === '#/login') location.hash = '#/studio';
}

function initAuthUi() {
  initPwUi();
  $('#btnSignIn').addEventListener('click', () => openAuth('login'));
  $('#btnLockedSignIn').addEventListener('click', () => openAuth('login'));
  $('#tabLogin').addEventListener('click', () => setAuthMode('login'));
  $('#tabRegister').addEventListener('click', () => setAuthMode('register'));

  $('#authForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!state.configured) return;
    setAuthMsg(null);
    const email = $('#authEmail').value.trim();
    const pass = $('#authPass').value;
    if (!email) return setAuthMsg('err', 'Please enter your email.');
    if (!pass) return setAuthMsg('err', 'Please enter your password.');
    if (state.authMode === 'register') {
      if (passStrength(pass).level < 2) return setAuthMsg('err', 'Please choose a stronger password: at least 8 characters, mixing upper/lower case, numbers or symbols.');
      if (pass !== $('#authPass2').value) return setAuthMsg('err', 'The passwords do not match. Please re-enter them.');
    }
    const btn = $('#btnAuthSubmit');
    btn.disabled = true;
    try {
      if (state.authMode === 'register') {
        const cred = await state.fb.createUserWithEmailAndPassword(state.auth, email, pass);
        const name = $('#authName').value.trim();
        if (name) await state.fb.updateProfile(cred.user, { displayName: name }).catch(() => {});
        onAuthChanged(state.auth.currentUser);
      } else {
        await state.fb.signInWithEmailAndPassword(state.auth, email, pass);
      }
      afterLogin();
    } catch (e) {
      setAuthMsg('err', authError(e));
    } finally {
      btn.disabled = false;
    }
  });

  $('#btnGoogle').addEventListener('click', async () => {
    if (!state.configured) return;
    setAuthMsg(null);
    const provider = new state.fb.GoogleAuthProvider();
    try {
      await state.fb.signInWithPopup(state.auth, provider);
      afterLogin();
    } catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
        try { await state.fb.signInWithRedirect(state.auth, provider); return; } catch (e2) { e = e2; }
      }
      setAuthMsg('err', authError(e));
    }
  });

  $('#btnForgot').addEventListener('click', async () => {
    const email = $('#authEmail').value.trim();
    if (!email) return setAuthMsg('err', 'Enter your email above first, then press "Forgot password?".');
    try {
      await state.fb.sendPasswordResetEmail(state.auth, email);
      setAuthMsg('ok', 'Password reset email sent. Check your inbox.');
    } catch (e) {
      setAuthMsg('err', authError(e));
    }
  });

  $('#btnSignOut').addEventListener('click', async () => {
    try {
      await state.fb.signOut(state.auth);
      toast('Signed out.', 'info');
    } catch (e) {
      toast(authError(e), 'err');
    }
  });
}

async function onAuthChanged(user) {
  const announce = () => window.dispatchEvent(new CustomEvent('d2c:auth', { detail: { user: user || null } }));
  if (state.user && user && state.user.uid === user.uid) {
    state.user = user;
    renderUser();
    announce();
    return;
  }
  if (state.unsub) { state.unsub(); state.unsub = null; }
  state.user = user || null;
  state.projects = [];
  resetStudio(true);
  renderUser();
  announce();

  if (!user) {
    renderProjects();
    renderSync();
    return;
  }

  // 1) instant paint from the local cache
  state.projects = lsGet('d2c:v1:' + user.uid + ':projects', []);
  renderProjects();

  // 2) synced preferences (follow the account across devices)
  const local = lsGet('d2c:v1:' + user.uid + ':settings', null);
  if (local) applySettings(local);
  try {
    const snap = await state.fb.getDoc(state.fb.doc(state.db, 'users', user.uid));
    if (snap.exists() && snap.data().settings) {
      applySettings(snap.data().settings);
      lsSet('d2c:v1:' + user.uid + ':settings', state.settings);
    }
  } catch (e) { /* offline is fine */ }

  // 3) live subscription — source of truth
  const col = state.fb.collection(state.db, 'users', user.uid, 'projects');
  const q = state.fb.query(col, state.fb.orderBy('updatedAt', 'desc'), state.fb.limit(100));
  state.unsub = state.fb.onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      state.fromCache = snap.metadata.fromCache;
      state.pendingWrites = snap.metadata.hasPendingWrites;
      state.projects = snap.docs.map((d) => normalizeProject(d.id, d.data({ serverTimestamps: 'estimate' })));
      writeCache();
      renderProjects();
      renderSync();
    },
    (err) => {
      console.error(err);
      if (err && err.code === 'permission-denied') {
        showSetupError('<strong>Database permission denied.</strong> Publish the rules from <code>firestore.rules</code> in Firebase Console → Firestore → Rules.');
      } else {
        toast('Could not sync projects: ' + (err.message || err.code), 'err');
      }
    }
  );
}

function renderUser() {
  const u = state.user;
  $('#btnSignIn').classList.toggle('d-none', !!u);
  $('#userMenu').classList.toggle('d-none', !u);
  $('#syncBadge').classList.toggle('d-none', !u);
  $('#studioLocked').classList.toggle('d-none', !!u);
  $('#studioApp').classList.toggle('d-none', !u);
  $('#projectsWrap').classList.toggle('d-none', !u);
  $('#projectsSub').textContent = u ? 'Everything you generate is saved to your account and available on any device.' : 'Sign in to see the projects saved to your account.';
  if (u) {
    const name = u.displayName || (u.email || 'User').split('@')[0];
    $('#userName').textContent = name;
    $('#userEmail').textContent = u.email || '';
    $('#userAvatar').textContent = (name[0] || 'U').toUpperCase();
  }
}

/* ------------------------------------------------------------------ */
/* Sync status + cache                                                 */
/* ------------------------------------------------------------------ */
function renderSync() {
  const b = $('#syncBadge');
  if (!state.user) return;
  let cls = '';
  let icon = 'bi-cloud-check';
  let text = 'Synced';
  if (!state.online) { cls = 'offline'; icon = 'bi-cloud-slash'; text = 'Offline'; }
  else if (state.pendingWrites) { cls = 'pending'; icon = 'bi-cloud-arrow-up'; text = 'Syncing…'; }
  else if (state.fromCache) { cls = 'pending'; icon = 'bi-cloud'; text = 'Connecting…'; }
  b.className = 'sync-badge ' + cls;
  b.innerHTML = '<i class="bi ' + icon + '"></i><span>' + text + '</span>';
}

function writeCache() {
  if (!state.user) return;
  const key = 'd2c:v1:' + state.user.uid + ':projects';
  if (lsSet(key, state.projects)) return;
  if (lsSet(key, state.projects.map((p) => ({ ...p, thumb: '' })))) return;
  lsSet(key, state.projects.slice(0, 10).map((p) => ({ ...p, thumb: '' })));
}

function applySettings(s) {
  if (!s) return;
  if (FRAMEWORKS[s.framework]) { state.settings.framework = s.framework; setRadio('framework', s.framework); }
  if (INPUT_TYPES[s.inputType]) { state.settings.inputType = s.inputType; setRadio('inputType', s.inputType); }
}

const saveSettings = debounce(async () => {
  if (!state.user) return;
  lsSet('d2c:v1:' + state.user.uid + ':settings', state.settings);
  try {
    await state.fb.setDoc(state.fb.doc(state.db, 'users', state.user.uid), { settings: state.settings, updatedAt: state.fb.serverTimestamp() }, { merge: true });
  } catch (e) { /* offline: will retry on next change */ }
}, 600);

/* ------------------------------------------------------------------ */
/* Projects data                                                       */
/* ------------------------------------------------------------------ */
function normalizeProject(id, d) {
  const ts = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : 0);
  return {
    id,
    name: d.name || 'Untitled project',
    framework: FRAMEWORKS[d.framework] ? d.framework : 'bootstrap',
    inputType: INPUT_TYPES[d.inputType] ? d.inputType : 'screenshot',
    files: Array.isArray(d.files) ? d.files.map((f) => ({ name: String(f.name), content: String(f.content) })) : [],
    thumb: d.thumb || '',
    hasImage: !!d.hasImage,
    version: d.version || 1,
    instructions: d.instructions || '',
    createdAt: ts(d.createdAt),
    updatedAt: ts(d.updatedAt),
  };
}

function projectRef(id) {
  return state.fb.doc(state.db, 'users', state.user.uid, 'projects', id);
}
function imageRef(id) {
  return state.fb.doc(state.db, 'users', state.user.uid, 'projects', id, 'assets', 'source');
}

async function persistProject({ isNew, withImage }) {
  const cur = state.current;
  if (!state.user || !cur) return false;
  if (totalBytes(cur.files) > MAX_DOC_BYTES) {
    toast('This project is too large to save (limit ~900 KB of code).', 'err');
    return false;
  }
  const fb = state.fb;
  const batch = fb.writeBatch(state.db);
  const base = {
    name: cur.name,
    framework: cur.framework,
    inputType: cur.inputType,
    files: cur.files.map((f) => ({ name: f.name, content: f.content })),
    version: cur.version,
    instructions: cur.instructions || '',
    updatedAt: fb.serverTimestamp(),
  };
  if (isNew) {
    base.createdAt = fb.serverTimestamp();
    base.thumb = (state.image && state.image.thumb) || '';
    base.hasImage = !!(state.image && state.image.data);
    batch.set(projectRef(cur.id), base);
  } else {
    if (withImage && state.image) {
      base.thumb = state.image.thumb;
      base.hasImage = true;
    }
    batch.set(projectRef(cur.id), base, { merge: true });
  }
  if (state.image && state.image.data && (isNew || withImage)) {
    batch.set(imageRef(cur.id), { data: state.image.data, updatedAt: fb.serverTimestamp() });
  }
  await batch.commit();
  return true;
}

const autosave = debounce(() => saveCurrent(true), 2000);

async function saveCurrent(silent = false) {
  if (!state.current || !state.user || state.generating) return;
  if (!state.dirty && silent) return;
  setSaveStatus('Saving…');
  try {
    // Firestore queues writes offline; commit() resolves when the server acknowledges.
    const p = persistProject({ isNew: false });
    state.dirty = false;
    const ok = await Promise.race([p, new Promise((r) => setTimeout(() => r('slow'), 4000))]);
    if (ok === false) { state.dirty = true; setSaveStatus('Not saved', 'err'); return; }
    if (ok === 'slow') { setSaveStatus('Saved locally · will sync', 'ok'); p.catch(() => {}); }
    else setSaveStatus('Saved', 'ok');
    if (!silent) toast('Project saved.', 'ok', 2200);
  } catch (e) {
    console.error(e);
    state.dirty = true;
    setSaveStatus('Save failed', 'err');
    toast('Save failed: ' + (e.message || e.code), 'err');
  }
}

function setSaveStatus(text, cls = '') {
  const el = $('#saveStatus');
  el.textContent = text;
  el.className = 'save-status ' + cls;
}

async function loadSourceImage(id) {
  try {
    const snap = await state.fb.getDoc(imageRef(id));
    if (snap.exists()) return snap.data().data || null;
  } catch (e) { /* offline and not cached */ }
  return null;
}

/* ------------------------------------------------------------------ */
/* Image handling                                                      */
/* ------------------------------------------------------------------ */
function loadImageEl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image.')); };
    img.src = url;
  });
}

function renderToJpeg(img, maxEdge, quality, bg = '#ffffff') {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { url: c.toDataURL('image/jpeg', quality), w, h };
}

async function processImage(file) {
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) throw new Error('Please upload a PNG, JPG, WEBP or GIF image.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Image is larger than 20 MB.');
  const img = await loadImageEl(file);
  let edge = 1800;
  let out = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const q of [0.86, 0.78, 0.7, 0.6]) {
      out = renderToJpeg(img, edge, q);
      if (out.url.length < 900000) { attempt = 99; break; }
    }
    if (attempt < 99) edge = Math.round(edge * 0.8);
  }
  if (!out || out.url.length >= 1300000) throw new Error('Could not compress this image enough. Try a smaller one.');
  const thumb = renderToJpeg(img, 360, 0.6).url;
  return { data: out.url, thumb, w: out.w, h: out.h };
}

async function setImageFromFile(file) {
  try {
    const dz = $('#dropzone');
    dz.style.opacity = '.6';
    state.image = await processImage(file);
    $('#imgPreview').src = state.image.data;
    $('#imgMeta').textContent = state.image.w + ' × ' + state.image.h + ' · ' + fmtBytes(Math.round(state.image.data.length * 0.75));
    $('#imgPreviewWrap').classList.remove('d-none');
    $('#dzEmpty').classList.add('d-none');
    if (!$('#projectName').value.trim()) $('#projectName').value = (file.name || 'My design').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').slice(0, 60);
  } catch (e) {
    toast(e.message || 'Could not use this image.', 'err');
  } finally {
    $('#dropzone').style.opacity = '';
  }
}

function clearImage() {
  state.image = null;
  $('#imgPreview').removeAttribute('src');
  $('#imgPreviewWrap').classList.add('d-none');
  $('#dzEmpty').classList.remove('d-none');
  $('#fileInput').value = '';
}

function initUpload() {
  const dz = $('#dropzone');
  const input = $('#fileInput');
  dz.addEventListener('click', (e) => { if (!e.target.closest('#btnClearImage')) input.click(); });
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => { if (input.files[0]) setImageFromFile(input.files[0]); });
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) setImageFromFile(f); });
  $('#btnClearImage').addEventListener('click', (e) => { e.stopPropagation(); clearImage(); });
  document.addEventListener('paste', (e) => {
    if (!state.user || state.generating) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { setImageFromFile(f); toast('Image pasted.', 'ok', 1800); e.preventDefault(); return; }
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Workspace rendering                                                 */
/* ------------------------------------------------------------------ */
function setPane(name) {
  state.pane = name;
  $$('.ws-tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === name));
  const hasFiles = !!(state.current && state.current.files.length) || state.generating;
  $('#paneEmpty').classList.toggle('d-none', hasFiles || name === 'source' && !!state.current);
  $('#panePreview').classList.toggle('d-none', !(hasFiles && name === 'preview'));
  $('#paneCode').classList.toggle('d-none', !(hasFiles && name === 'code'));
  $('#paneSource').classList.toggle('d-none', !(name === 'source' && !!state.current));
  if (name === 'preview' && hasFiles && !state.generating) refreshPreview();
  if (name === 'code') renderCode();
  if (name === 'source') renderSource();
}

function refreshPreview() {
  if (!state.current) return;
  $('#previewFrame').srcdoc = buildPreview(state.current.files);
}
const refreshPreviewSoon = debounce(refreshPreview, 450);

function renderCode() {
  const files = state.current ? state.current.files : [];
  if (state.activeFile >= files.length) state.activeFile = 0;
  const tabs = $('#fileTabs');
  tabs.innerHTML = '';
  files.forEach((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'file-tab' + (i === state.activeFile ? ' active' : '');
    b.textContent = f.name;
    b.addEventListener('click', () => { state.activeFile = i; renderCode(); });
    tabs.appendChild(b);
  });
  const ed = $('#codeEditor');
  const f = files[state.activeFile];
  if (document.activeElement !== ed || ed.value !== (f ? f.content : '')) ed.value = f ? f.content : '';
  ed.readOnly = state.generating;
  updateCodeInfo();
}

function updateCodeInfo() {
  const cur = state.current;
  if (!cur) { $('#codeInfo').textContent = ''; return; }
  const f = cur.files[state.activeFile];
  const lines = f ? f.content.split('\n').length : 0;
  $('#codeInfo').textContent = (f ? f.name + ' · ' + lines + ' lines · ' : '') + 'total ' + fmtBytes(totalBytes(cur.files)) + ' · ' + FRAMEWORKS[cur.framework].label;
}

async function renderSource() {
  const img = $('#sourceImg');
  const none = $('#sourceNone');
  let data = state.image && state.image.data;
  if (!data && state.current && state.current.hasImage) {
    none.textContent = 'Loading source image…';
    none.classList.remove('d-none');
    data = await loadSourceImage(state.current.id);
    if (data) state.image = { data, thumb: state.current.thumb || '', w: 0, h: 0 };
  }
  if (data) { img.src = data; img.classList.remove('d-none'); none.classList.add('d-none'); }
  else { img.classList.add('d-none'); none.textContent = 'No source image is stored for this project.'; none.classList.remove('d-none'); }
}

function initWorkspaceUi() {
  $$('.ws-tab').forEach((t) => t.addEventListener('click', () => setPane(t.dataset.pane)));
  $$('.dev').forEach((b) => b.addEventListener('click', () => {
    state.device = b.dataset.device;
    $$('.dev').forEach((x) => x.classList.toggle('active', x === b));
    $('#frameWrap').dataset.device = state.device;
    $('#devLabel').textContent = state.device[0].toUpperCase() + state.device.slice(1);
  }));

  const ed = $('#codeEditor');
  ed.addEventListener('input', () => {
    if (!state.current || state.generating) return;
    state.current.files[state.activeFile].content = ed.value;
    state.dirty = true;
    setSaveStatus('Unsaved changes');
    updateCodeInfo();
    refreshPreviewSoon();
    autosave();
  });
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ed.selectionStart;
      ed.setRangeText('  ', s, ed.selectionEnd, 'end');
      ed.dispatchEvent(new Event('input'));
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.user && state.current) {
      e.preventDefault();
      autosave.cancel();
      saveCurrent(false);
    }
    if (e.key === 'Escape' && !$('#fsOverlay').classList.contains('d-none')) closeFullscreen();
  });

  $('#btnSave').addEventListener('click', () => { autosave.cancel(); saveCurrent(false); });
  $('#btnCopy').addEventListener('click', async () => {
    const f = state.current && state.current.files[state.activeFile];
    if (!f) return toast('Nothing to copy yet.', 'info');
    try {
      await navigator.clipboard.writeText(f.content);
      toast('Copied ' + f.name, 'ok', 2000);
    } catch (e) {
      $('#codeEditor').select();
      toast('Press Ctrl+C to copy the selected code.', 'info');
    }
  });
  $('#btnZip').addEventListener('click', downloadZip);
  $('#btnNew').addEventListener('click', () => { resetStudio(false); toast('Ready for a new project.', 'info', 1800); });
  $('#btnFullscreen').addEventListener('click', () => {
    if (!state.current || !state.current.files.length) return toast('Generate or open a project first.', 'info');
    $('#fsFrame').srcdoc = buildPreview(state.current.files);
    $('#fsOverlay').classList.remove('d-none');
    document.body.style.overflow = 'hidden';
  });
  $('#fsClose').addEventListener('click', closeFullscreen);

  $('#projectName').addEventListener('change', async () => {
    const name = $('#projectName').value.trim().slice(0, 80);
    if (state.current && name && name !== state.current.name && !state.generating) {
      state.current.name = name;
      state.dirty = true;
      await saveCurrent(true);
    }
  });
  $$('input[name="framework"]').forEach((r) => r.addEventListener('change', () => { state.settings.framework = r.value; saveSettings(); }));
  $$('input[name="inputType"]').forEach((r) => r.addEventListener('change', () => { state.settings.inputType = r.value; saveSettings(); }));

  $('#btnGenerate').addEventListener('click', () => generate({ mode: 'new' }));
  $('#btnCancel').addEventListener('click', () => { if (state.abort) state.abort.abort(); });
  $('#btnImprove').addEventListener('click', () => {
    if (!state.current || !state.current.files.length) return toast('Open or generate a project first.', 'info');
    $('#improveText').value = '';
    $('#improveCopy').checked = false;
    modal('#improveModal').show();
  });
  $('#btnImproveGo').addEventListener('click', () => {
    modal('#improveModal').hide();
    generate({ mode: 'improve', instructions: $('#improveText').value.trim(), asCopy: $('#improveCopy').checked });
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty || state.generating) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('online', () => { state.online = true; renderSync(); });
  window.addEventListener('offline', () => { state.online = false; renderSync(); });
}

function closeFullscreen() {
  $('#fsOverlay').classList.add('d-none');
  $('#fsFrame').srcdoc = '';
  document.body.style.overflow = '';
}

function resetStudio(full) {
  autosave.cancel();
  state.current = null;
  state.dirty = false;
  state.activeFile = 0;
  if (full) setRadio('framework', 'bootstrap'), setRadio('inputType', 'screenshot');
  clearImage();
  $('#projectName').value = '';
  $('#extraInstructions').value = '';
  $('#previewFrame').srcdoc = '';
  $('#codeEditor').value = '';
  setSaveStatus('');
  setPane('preview');
}

function downloadZip() {
  if (!state.current || !state.current.files.length) return toast('Nothing to download yet.', 'info');
  const bytes = makeZip(state.current.files);
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = slugify(state.current.name) + '.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Downloaded ' + a.download, 'ok', 2500);
}

/* ------------------------------------------------------------------ */
/* Generation (streams from /api/generate)                             */
/* ------------------------------------------------------------------ */
function setGenUi(on) {
  state.generating = on;
  $('#genProgress').classList.toggle('d-none', !on);
  $('#btnGenerate').disabled = on;
  $('#btnImprove').disabled = on;
  $('#btnNew').disabled = on;
  $('#codeEditor').readOnly = on;
}

function stageFor(chars, files) {
  if (!chars) return 'Analyzing your design…';
  if (!files.length) return 'Reading layout, colors and text…';
  const last = files[files.length - 1].name;
  return 'Writing ' + last + '…';
}

async function generate({ mode, instructions = '', asCopy = false }) {
  if (state.generating) return;
  if (!state.user) return openAuth('login');
  if (!state.aiReady) return toast('AI is not configured on the server yet. Ask the site owner to add the AI API key.', 'err');

  const improving = mode === 'improve' && state.current;
  if (!improving && !state.image) {
    toast('Upload a design image first.', 'err');
    $('#dropzone').focus();
    return;
  }

  const framework = improving ? state.current.framework : radioValue('framework') || 'bootstrap';
  const inputType = improving ? state.current.inputType : radioValue('inputType') || 'screenshot';
  const name = ($('#projectName').value.trim() || (improving ? state.current.name : 'Untitled project')).slice(0, 80);
  const extra = improving ? instructions : $('#extraInstructions').value.trim();

  if (improving && !state.image && state.current.hasImage) {
    const data = await loadSourceImage(state.current.id);
    if (data) state.image = { data, thumb: state.current.thumb || '', w: 0, h: 0 };
  }

  let token;
  try {
    token = await state.user.getIdToken();
  } catch (e) {
    return toast('Session expired. Please sign in again.', 'err');
  }

  const payload = { framework, inputType, projectName: name, instructions: extra };
  if (state.image) payload.image = state.image.data;
  if (improving) payload.previousFiles = state.current.files;

  setGenUi(true);
  setPane('code');
  state.abort = new AbortController();
  $('#genBar').style.width = '4%';
  $('#genStage').textContent = 'Analyzing your design…';
  $('#genChars').textContent = '0 chars';

  const target = { id: '', files: [] };
  let raw = '';
  let failure = '';
  let truncated = false;
  let raf = 0;
  const expected = FRAMEWORKS[framework].files.length;

  const paint = () => {
    raf = 0;
    const files = parseFiles(raw, { streaming: true });
    target.files = files;
    $('#genChars').textContent = raw.length.toLocaleString() + ' chars';
    $('#genStage').textContent = stageFor(raw.length, files);
    const pct = Math.min(94, 6 + (files.length / expected) * 40 + Math.min(48, raw.length / 400));
    $('#genBar').style.width = pct.toFixed(0) + '%';
    // live code view
    state.current = state.current || { id: '', name, framework, inputType, files: [], version: 1 };
    const view = { ...state.current, files };
    $('#paneEmpty').classList.add('d-none');
    $('#paneCode').classList.remove('d-none');
    $('#panePreview').classList.add('d-none');
    const tabs = $('#fileTabs');
    tabs.innerHTML = files.map((f, i) => '<button type="button" class="file-tab' + (i === files.length - 1 ? ' active' : '') + '">' + escapeHtml(f.name) + '</button>').join('');
    const ed = $('#codeEditor');
    const lastF = files[files.length - 1];
    ed.value = lastF ? lastF.content : '';
    ed.scrollTop = ed.scrollHeight;
    $('#codeInfo').textContent = 'Generating… ' + fmtBytes(totalBytes(view.files));
  };

  const prevCurrent = state.current;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      signal: state.abort.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const err = new Error(j.error || 'Generation failed (' + res.status + ').');
      if (res.status === 402) {
        // Trial ended / limit reached: this is not a bug, so show ONE clear message (no "Explain this error" offer).
        err.billing = true;
        window.dispatchEvent(new CustomEvent('d2c:upgrade', { detail: { message: j.error, reason: j.reason, resetAt: j.resetAt } }));
      }
      throw err;
    }
    if (!res.body) throw new Error('Your browser does not support streaming responses.');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      if (!raf) raf = requestAnimationFrame(paint);
    }
    raw += dec.decode();
  } catch (e) {
    if (e.name === 'AbortError') failure = 'cancelled';
    else if (e.billing) failure = 'billing';
    else failure = e.message || 'Generation failed.';
  }
  if (raf) cancelAnimationFrame(raf);

  // markers appended by the server
  const errIdx = raw.indexOf('[[D2C_ERROR]]');
  if (errIdx !== -1) { failure = failure || raw.slice(errIdx + 13).trim() || 'The AI service reported an error.'; raw = raw.slice(0, errIdx); }
  const trIdx = raw.indexOf('[[D2C_TRUNCATED]]');
  if (trIdx !== -1) { truncated = true; raw = raw.slice(0, trIdx); }

  const files = parseFiles(raw);
  const hasHtml = files.some((f) => /\.html?$/i.test(f.name) && f.content.trim().length > 40);

  setGenUi(false);
  window.dispatchEvent(new CustomEvent('d2c:genend'));
  state.abort = null;
  state.current = prevCurrent;

  if (failure === 'cancelled') {
    toast('Generation cancelled.', 'info');
    finishGenView();
    return;
  }
  if (failure === 'billing') {
    finishGenView();
    return;
  }
  if (failure && !hasHtml) {
    toast(failure, 'err', 7000);
    reportError('Generation failed: ' + failure);
    finishGenView();
    return;
  }
  if (!hasHtml) {
    toast('The AI did not return a complete website. Please try again.', 'err', 7000);
    reportError('The AI did not return a complete website (no valid index.html in the response).');
    finishGenView();
    return;
  }

  // Success — create or update the project and save it.
  const now = Date.now();
  const keepId = improving && !asCopy ? state.current.id : '';
  const id = keepId || state.fb.doc(state.fb.collection(state.db, 'users', state.user.uid, 'projects')).id;
  const isNew = !keepId;
  state.current = {
    id,
    name,
    framework,
    inputType,
    files,
    version: improving && !asCopy ? (state.current.version || 1) + 1 : 1,
    instructions: extra,
    hasImage: !!state.image,
    thumb: (state.image && state.image.thumb) || (state.current && state.current.thumb) || '',
    createdAt: isNew ? now : state.current.createdAt,
    updatedAt: now,
  };
  state.activeFile = 0;
  state.dirty = false;
  clearAutosaveStatus();
  setPane('preview');
  $('#projectName').value = name;

  try {
    const p = persistProject({ isNew, withImage: !isNew && !!state.image });
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('slow'), 4000))]);
    if (r === false) setSaveStatus('Not saved', 'err');
    else if (r === 'slow') { setSaveStatus('Saved locally · will sync', 'ok'); p.catch(() => {}); }
    else setSaveStatus('Saved to cloud', 'ok');
  } catch (e) {
    console.error(e);
    setSaveStatus('Save failed', 'err');
    toast('Generated, but saving failed: ' + (e.message || e.code), 'err', 7000);
  }

  if (truncated) toast('The output was long and got cut off. Use Regenerate with "make it shorter" to finish it.', 'info', 8000);
  else if (failure) toast('Generated with a warning: ' + failure, 'info', 6000);
  else toast('Website generated and saved.', 'ok');
}

function reportError(message) {
  window.dispatchEvent(new CustomEvent('d2c:error', { detail: { message } }));
}

function clearAutosaveStatus() { setSaveStatus(''); }

function finishGenView() {
  if (state.current && state.current.files.length) setPane('preview');
  else { $('#paneCode').classList.add('d-none'); setPane('preview'); }
}

/* ------------------------------------------------------------------ */
/* Projects list                                                       */
/* ------------------------------------------------------------------ */
function renderProjects() {
  const grid = $('#projectGrid');
  const q = ($('#projectSearch').value || '').trim().toLowerCase();
  const list = state.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
  $('#projectCount').textContent = state.projects.length + (state.projects.length === 1 ? ' project' : ' projects');
  $('#projectEmpty').classList.toggle('d-none', state.projects.length > 0);
  grid.innerHTML = '';
  list.forEach((p) => {
    const col = document.createElement('div');
    col.className = 'col-sm-6 col-lg-4 col-xl-3';
    const size = fmtBytes(totalBytes(p.files));
    col.innerHTML =
      '<article class="proj-card">' +
      '<div class="proj-thumb" role="button" tabindex="0" data-open="' + escapeHtml(p.id) + '" aria-label="Open project">' +
      (p.thumb ? '<img alt="" loading="lazy" src="' + escapeHtml(p.thumb) + '">' : '<i class="bi bi-window-sidebar"></i>') +
      '</div>' +
      '<div class="proj-body">' +
      '<h3 class="proj-name" title="' + escapeHtml(p.name) + '">' + escapeHtml(p.name) + '</h3>' +
      '<div class="proj-meta"><span class="pill">' + escapeHtml(FRAMEWORKS[p.framework].short) + '</span><span class="pill">' + escapeHtml(size) + '</span><span class="pill">v' + p.version + '</span></div>' +
      '<div class="small text-secondary">' + escapeHtml(fmtDate(p.updatedAt)) + '</div>' +
      '<div class="proj-actions">' +
      '<button class="btn btn-sm btn-brand" data-open="' + escapeHtml(p.id) + '" type="button"><i class="bi bi-box-arrow-up-right me-1"></i>Open</button>' +
      '<button class="btn btn-icon" data-zip="' + escapeHtml(p.id) + '" type="button" title="Download ZIP" aria-label="Download ZIP"><i class="bi bi-download"></i></button>' +
      '<button class="btn btn-icon" data-del="' + escapeHtml(p.id) + '" type="button" title="Delete" aria-label="Delete project"><i class="bi bi-trash3"></i></button>' +
      '</div></div></article>';
    grid.appendChild(col);
  });
  if (state.projects.length && !list.length) grid.innerHTML = '<div class="col-12 text-center text-secondary py-4">No projects match your search.</div>';
}

async function openProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  if (state.generating) return toast('Please wait for the current generation to finish.', 'info');
  if (state.dirty) await saveCurrent(true);
  autosave.cancel();
  state.current = JSON.parse(JSON.stringify(p));
  state.image = null;
  state.activeFile = 0;
  state.dirty = false;
  setRadio('framework', p.framework);
  setRadio('inputType', p.inputType);
  $('#projectName').value = p.name;
  $('#extraInstructions').value = '';
  clearImage();
  setSaveStatus('');
  setPane('preview');
  location.hash = '#/studio';
}

function initProjectsUi() {
  $('#projectSearch').addEventListener('input', renderProjects);
  $('#projectGrid').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    const zip = e.target.closest('[data-zip]');
    const del = e.target.closest('[data-del]');
    if (open) openProject(open.dataset.open);
    else if (zip) {
      const p = state.projects.find((x) => x.id === zip.dataset.zip);
      if (!p) return;
      const url = URL.createObjectURL(new Blob([makeZip(p.files)], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = slugify(p.name) + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } else if (del) askDelete(del.dataset.del);
  });
  $('#projectGrid').addEventListener('keydown', (e) => {
    const open = e.target.closest('.proj-thumb[data-open]');
    if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openProject(open.dataset.open); }
  });
}

let pendingDelete = '';
function askDelete(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  pendingDelete = id;
  $('#confirmText').textContent = '"' + p.name + '" will be permanently deleted from all your devices.';
  modal('#confirmModal').show();
}

function initConfirm() {
  $('#confirmOk').addEventListener('click', async () => {
    const id = pendingDelete;
    if (!id || !state.user) return;
    pendingDelete = '';
    modal('#confirmModal').hide();
    try {
      const batch = state.fb.writeBatch(state.db);
      batch.delete(imageRef(id));
      batch.delete(projectRef(id));
      await Promise.race([batch.commit(), new Promise((r) => setTimeout(r, 4000))]);
      if (state.current && state.current.id === id) resetStudio(false);
      toast('Project deleted.', 'ok', 2500);
    } catch (e) {
      console.error(e);
      toast('Could not delete: ' + (e.message || e.code), 'err');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
function init() {
  initChrome();
  initAuthUi();
  initUpload();
  initWorkspaceUi();
  initProjectsUi();
  initConfirm();
  renderUser();
  renderProjects();
  setPane('preview');
  bootFirebase();
}

window.D2C = {
  state,
  toast,
  openAuth,
  getToken: () => (state.user ? state.user.getIdToken() : Promise.reject(new Error('Not signed in'))),
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
