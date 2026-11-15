'use strict';
if (!process.env.VERCEL && typeof process.loadEnvFile === 'function') {
  const localEnvFile = require('path').join(process.cwd(), '.env');
  if (require('fs').existsSync(localEnvFile)) process.loadEnvFile(localEnvFile);
}
// Gemini is the only AI provider used by the system.
//   gemini : GEMINI_API_KEY (or GOOGLE_API_KEY)
// Models per quality level can be set with <PROVIDER>_MODEL_LOW / _STANDARD / _HIGH, or one
// <PROVIDER>_MODEL for all levels. See DEFAULT_MODEL below.
//
// Messages use one neutral shape: { role:'user'|'assistant', content: string | parts[] }
// where parts are { type:'text', text } or { type:'image', mime, data(base64) }.

// Quality levels (what the plans sell). Each one really changes the AI call:
//   low      -> fastest, cheapest model / least reasoning, smaller output budget
//   standard -> balanced model / medium reasoning, normal output budget
//   high     -> most capable model / deepest reasoning, biggest output budget
const QUALITY = {
  low: { label: 'Low', speed: 'Fastest', outputX: 0.65, effort: 'low', blurb: 'Fast, lightweight model. Best for simple pages.' },
  standard: { label: 'Standard', speed: 'Balanced', outputX: 1, effort: 'medium', blurb: 'Balanced model. Good for most full websites.' },
  high: { label: 'High', speed: 'Slower (deepest reasoning)', outputX: 1.5, effort: 'high', blurb: 'Most capable model with the deepest reasoning. Best fidelity on complex designs.' },
  basic: { label: 'Basic', speed: 'Fastest', outputX: 0.4, effort: 'low', blurb: 'Simple code only: a clean, basic page with no advanced features.' },
};
const BASE_OUTPUT_TOKENS = () => Number(process.env.MAX_OUTPUT_TOKENS || 16000);
const outputTokens = (q) => Math.round(BASE_OUTPUT_TOKENS() * (QUALITY[q] || QUALITY.standard).outputX);

const DEFAULT_MODEL = {
  gemini: { low: 'gemini-3.5-flash-lite', standard: 'gemini-3.8-flash', high: 'gemini-3.8-flash' },
};
const FALLBACK_MODELS = {
  gemini: ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
};
const PROVIDER_ORDER = ['gemini'];
const providerCooldowns = new Map();
const KEY_NAME = { gemini: 'GEMINI_API_KEY' };
const LABEL = { gemini: 'Gemini' };
const QUOTA_ERROR = /insufficient_quota|billing|quota|credit balance|credit.{0,30}(?:low|exhausted|limit)|(?:out of|no) credits?|resource[_ ]exhausted|usage limit|payment required/i;

// Reads a Vercel variable; ignores stray spaces, quotes and a pasted "NAME=" prefix.
const env = (n) => String(process.env[n] || '').trim().replace(new RegExp('^' + n + '\\s*=\\s*'), '').replace(/^['"]+|['"]+$/g, '').trim();
const keyFor = (p) => env(KEY_NAME[p]) || (p === 'gemini' ? env('GOOGLE_API_KEY') : '');

function pickProvider() {
  return 'gemini';
}

function modelFor(provider, quality) {
  if (quality === 'basic') quality = 'low'; // basic uses the cheapest model
  const P = provider.toUpperCase();
  return env(P + '_MODEL_' + quality.toUpperCase()) || env(P + '_MODEL') || DEFAULT_MODEL[provider][quality];
}

function configuredProviders() {
  return PROVIDER_ORDER.filter((provider) => keyFor(provider)).map((provider) => ({ provider, label: LABEL[provider] }));
}

function info(quality) {
  const q = QUALITY[quality] ? quality : 'standard';
  const provider = pickProvider();
  return {
    provider,
    label: LABEL[provider],
    key: keyFor(provider),
    keyName: KEY_NAME[provider],
    modelEnv: provider.toUpperCase() + '_MODEL_' + (q === 'basic' ? 'LOW' : q.toUpperCase()),
    quality: q,
    model: modelFor(provider, q),
    models: { low: modelFor(provider, 'low'), standard: modelFor(provider, 'standard'), high: modelFor(provider, 'high') },
    configured: !!keyFor(provider),
  };
}

const parts = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

function buildRequest(cfg, { system, messages, maxTokens }) {
  // Gemini thinking tokens count against the output budget.
  const budget = Math.min(maxTokens * 2, 64000);
  const gen = { maxOutputTokens: budget };
  if (env('GEMINI_THINKING_LEVEL')) gen.thinkingConfig = { thinkingLevel: env('GEMINI_THINKING_LEVEL') };
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cfg.model.replace(/^models\//, '')) + ':streamGenerateContent?alt=sse',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.key },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: parts(m.content).map((p) => (p.type === 'image' ? { inlineData: { mimeType: p.mime, data: p.data } } : { text: p.text })),
      })),
      generationConfig: gen,
    },
  };
}

/** Turns a provider HTTP error into { status (for our client), message }. */
function friendlyError(cfg, status, text) {
  const t = String(text || '');
  if (QUOTA_ERROR.test(t) && status !== 401) return { status: 502, message: cfg.label + ' account has no credit or quota left. Add billing / credit to the ' + cfg.label + ' account.' };
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|invalid x-api-key|Incorrect API key/i.test(t)) return { status: 502, message: 'AI credentials were rejected. Check ' + cfg.keyName + '.' };
  if (status === 404) return { status: 502, message: 'AI model "' + cfg.model + '" was not found. Check ' + cfg.modelEnv + '.' };
  if (status === 429 || status === 529 || status === 503) return { status: 503, message: 'The AI service is busy. Please try again in a moment.' };
  if (status === 400 && /model/i.test(t) && /not (found|supported)|does not exist|invalid/i.test(t)) return { status: 502, message: 'AI model "' + cfg.model + '" was rejected. Check ' + cfg.modelEnv + '.' };
  return { status: 502, message: 'The AI service returned an error (' + status + ').' };
}

/** Handles one parsed Gemini stream event; calls onText(text) and fills state.stop / state.error. */
function handleEvent(ev, onText, state) {
  if (ev.error) { state.error = ev.error.message || 'The AI service reported an error.'; return; }
  if (ev.promptFeedback && ev.promptFeedback.blockReason) { state.error = 'The AI blocked this request (' + ev.promptFeedback.blockReason + '). Try a different image or wording.'; return; }
  const c = ev.candidates && ev.candidates[0];
  if (!c) return;
  for (const p of (c.content && c.content.parts) || []) if (typeof p.text === 'string' && p.text && !p.thought) onText(p.text);
  if (c.finishReason === 'MAX_TOKENS') state.stop = 'max_tokens';
  else if (/^(SAFETY|RECITATION|PROHIBITED_CONTENT|BLOCKLIST|SPII|IMAGE_SAFETY)$/.test(c.finishReason || '')) state.error = 'The AI blocked this response (' + c.finishReason + '). Try a different image or wording.';
}

/**
 * Starts a streaming request.
 * Returns { ok:false, status, message } if the provider refused it, otherwise
 * { ok:true, read(onText) } where read() streams text and resolves to { stop, error }.
 */
async function open(args) {
  // Gemini is the only provider. Unsupported Gemini models are retried inside openOne().
  const first = info(args.quality).provider;
  const configured = PROVIDER_ORDER.filter((p) => keyFor(p));
  const ready = configured.filter((p) => (providerCooldowns.get(p) || 0) <= Date.now());
  const candidates = ready.length ? ready : configured;
  const order = (candidates.indexOf(first) !== -1 ? [first] : []).concat(candidates.filter((p) => p !== first));
  if (!order.length) order.push(first);
  const cool = (provider, message) => {
    const needsBilling = /quota|credit|billing|credential|rejected|model .*not found/i.test(message || '');
    providerCooldowns.set(provider, Date.now() + (needsBilling ? 5 * 60 * 1000 : 30 * 1000));
  };
  let lastFail = null;
  for (let i = 0; i < order.length; i++) {
    const r = await openOne(args);
    if (!r.ok) {
      lastFail = r;
      if (!(args.signal && args.signal.aborted)) cool(first, r.message);
      if (args.signal && args.signal.aborted) return r;
      continue;
    }

    providerCooldowns.delete(first);
    return {
      ok: true,
      async read(onText) {
        let emitted = false;
        const state = await r.read((text) => { emitted = true; onText(text); });
        if (emitted || (args.signal && args.signal.aborted)) return state;

        if (state.error) lastFail = { ok: false, status: 502, message: state.error };
        else lastFail = { ok: false, status: 502, message: 'The AI provider returned no text.' };
        cool(first, lastFail.message);

        for (let j = i + 1; j < order.length; j++) {
          const next = await openOne(args);
          if (!next.ok) {
            lastFail = next;
            if (!(args.signal && args.signal.aborted)) cool(first, next.message);
            if (args.signal && args.signal.aborted) break;
            continue;
          }

          providerCooldowns.delete(first);
          let nextEmitted = false;
          const nextState = await next.read((text) => { nextEmitted = true; onText(text); });
          if (nextEmitted || (args.signal && args.signal.aborted)) return nextState;
          lastFail = {
            ok: false,
            status: 502,
            message: nextState.error || 'The AI provider returned no text.',
          };
          cool(first, lastFail.message);
        }

        return { stop: '', error: lastFail.message };
      },
    };
  }
  return lastFail;
}

async function openOne({ system, messages, maxTokens, signal, quality, providerTimeoutMs }) {
  const cfg = info(quality);
  if (!cfg.configured) return { ok: false, status: 500, message: 'AI service is not configured. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in Vercel.' };
  // If a model name is not available on this account (404 / "model not found"), try other current models of the same
  // provider before giving up. A model the owner set in Vercel (<PROVIDER>_MODEL...) is tried first.
  const tryModels = [cfg.model].concat((FALLBACK_MODELS[cfg.provider] || []).filter((m) => m !== cfg.model));
  let up, used = cfg;
  let releaseStream = () => {};
  let streamController;
  for (let i = 0; i < tryModels.length; i++) {
    used = { ...cfg, model: tryModels[i] };
    const reqd = buildRequest(used, { system, messages, maxTokens });
    const requestController = new AbortController();
    const abortFromCaller = () => requestController.abort();
    if (signal) {
      if (signal.aborted) requestController.abort();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    let timedOut = false;
    const timer = providerTimeoutMs > 0 ? setTimeout(() => { timedOut = true; requestController.abort(); }, providerTimeoutMs) : null;
    const releaseRequest = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortFromCaller);
    };
    try {
      up = await fetch(reqd.url, { method: 'POST', signal: requestController.signal, headers: reqd.headers, body: JSON.stringify(reqd.body) });
    } catch (e) {
      releaseRequest();
      const callerAborted = !!(signal && signal.aborted);
      return {
        ok: false,
        status: timedOut ? 504 : 502,
        message: timedOut ? cfg.label + ' took too long to start responding.' : 'Could not reach the AI service. Please try again.',
        retry: !callerAborted,
      };
    }
    if (timer) clearTimeout(timer);
    if (up.ok) {
      releaseStream = releaseRequest;
      streamController = requestController;
      break;
    }
    const text = await up.text().catch(() => '');
    releaseRequest();
    const modelProblem = up.status === 404 || (up.status === 400 && /model/i.test(text) && /not (found|supported)|does not exist|invalid/i.test(text));
    if (modelProblem && i < tryModels.length - 1) continue;
    const f = friendlyError(used, up.status, text);
    const retry = up.status === 401 || up.status === 402 || up.status === 403 || up.status === 404 || up.status === 429 || up.status === 529 || up.status >= 500 || QUOTA_ERROR.test(text) || /API key not valid/i.test(text) || modelProblem;
    (retry ? console.warn : console.error)('AI upstream error', cfg.provider, used.model, up.status, text.slice(0, 400));
    return { ok: false, status: f.status, message: f.message, retry };
  }
  return {
    ok: true,
    async read(onText) {
      const state = { stop: '', error: '' };
      const dec = new TextDecoder();
      let buf = '';
      let receivedText = false;
      let streamTimedOut = false;
      const firstTextTimer = providerTimeoutMs > 0 ? setTimeout(() => {
        if (!receivedText) {
          streamTimedOut = true;
          streamController.abort();
        }
      }, providerTimeoutMs) : null;
      const emitText = (text) => {
        if (text) {
          receivedText = true;
          if (firstTextTimer) clearTimeout(firstTextTimer);
        }
        onText(text);
      };
      const block = (b) => {
        let data = '';
        for (const l of b.split('\n')) if (l.startsWith('data:')) data += l.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try { handleEvent(JSON.parse(data), emitText, state); } catch (e) { /* ignore a broken event */ }
      };
      try {
        const reader = up.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) { block(buf.slice(0, i)); buf = buf.slice(i + 2); }
        }
        if (buf.trim()) block(buf);
      } catch (e) {
        if (!(signal && signal.aborted)) state.error = state.error || (streamTimedOut ? cfg.label + ' did not start responding in time.' : 'The connection to the AI service was interrupted.');
      } finally {
        if (firstTextTimer) clearTimeout(firstTextTimer);
        releaseStream();
      }
      return state;
    },
  };
}

/** Small non-streaming helper (used by the owner "Test AI" button). */
async function ask(system, userText, maxTokens, quality) {
  const r = await open({ system, messages: [{ role: 'user', content: userText }], maxTokens: maxTokens || 60, quality });
  if (!r.ok) return { ok: false, message: r.message };
  let out = '';
  const st = await r.read((t) => { out += t; });
  if (st.error) return { ok: false, message: st.error };
  if (!out.trim()) return { ok: false, message: 'The model returned no text.' };
  return { ok: true, text: out.trim() };
}

module.exports = { info, open, ask, configuredProviders, QUALITY, outputTokens, LABEL, KEY_NAME, DEFAULT_MODEL };
