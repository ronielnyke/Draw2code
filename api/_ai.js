'use strict';
// One AI layer for the whole system: Claude (Anthropic), Gemini (Google) or ChatGPT (OpenAI).
// Pick with env AI_PROVIDER = anthropic | gemini | openai. If it is not set, the first provider
// that has an API key is used (order: anthropic, gemini, openai).
//
//   anthropic : ANTHROPIC_API_KEY
//   gemini    : GEMINI_API_KEY
//   openai    : OPENAI_API_KEY
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
  anthropic: { low: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', high: 'claude-opus-5-5' },
  gemini: { low: 'gemini-3.1-flash-lite', standard: 'gemini-3.8-flash', high: 'gemini-3.1-pro-preview' },
  openai: { low: 'gpt-5.5', standard: 'gpt-5.5', high: 'gpt-5.5' }, // OpenAI: same model, different reasoning effort
};
const FALLBACK_MODELS = {
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  openai: ['gpt-4.1', 'gpt-4o', 'gpt-5'],
};
const KEY_NAME = { anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' };
const LABEL = { anthropic: 'Claude', gemini: 'Gemini', openai: 'ChatGPT (OpenAI)' };
const ALIAS = { claude: 'anthropic', google: 'gemini', chatgpt: 'openai', gpt: 'openai' };

// Reads a Vercel variable; ignores stray spaces, quotes and a pasted "NAME=" prefix.
const env = (n) => String(process.env[n] || '').trim().replace(new RegExp('^' + n + '\\s*=\\s*'), '').replace(/^['"]+|['"]+$/g, '').trim();
const keyFor = (p) => env(KEY_NAME[p]) || (p === 'gemini' ? env('GOOGLE_API_KEY') : '');

function pickProvider() {
  const want = env('AI_PROVIDER').toLowerCase();
  const p = ALIAS[want] || want;
  if (KEY_NAME[p]) return p;
  for (const c of ['anthropic', 'gemini', 'openai']) if (keyFor(c)) return c;
  return 'anthropic';
}

function modelFor(provider, quality) {
  if (quality === 'basic') quality = 'low'; // basic uses the cheapest model
  const P = provider.toUpperCase();
  return env(P + '_MODEL_' + quality.toUpperCase()) || env(P + '_MODEL') || DEFAULT_MODEL[provider][quality];
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
  if (cfg.provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: {
        model: cfg.model,
        max_tokens: maxTokens,
        stream: true,
        system,
        messages: messages.map((m) => ({
          role: m.role,
          content: parts(m.content).map((p) => (p.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
            : { type: 'text', text: p.text })),
        })),
      },
    };
  }
  // Gemini and GPT-5 class models "think" before answering, and those thinking tokens count
  // against the output limit, so they get a bigger budget than Claude.
  const budget = Math.min(maxTokens * 2, 64000);
  if (cfg.provider === 'openai') {
    const body = {
      model: cfg.model,
      stream: true,
      max_completion_tokens: budget,
      messages: [{ role: 'system', content: system }].concat(messages.map((m) => ({
        role: m.role,
        content: m.role === 'assistant'
          ? parts(m.content).map((p) => p.text).join('')
          : parts(m.content).map((p) => (p.type === 'image'
            ? { type: 'image_url', image_url: { url: 'data:' + p.mime + ';base64,' + p.data } }
            : { type: 'text', text: p.text })),
      }))),
    };
    if (env('OPENAI_REASONING_EFFORT').toLowerCase() !== 'off' && /^(gpt-5|o\d)/.test(cfg.model)) body.reasoning_effort = QUALITY[cfg.quality].effort;
    return { url: 'https://api.openai.com/v1/chat/completions', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key }, body };
  }
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
  if (/insufficient_quota|billing|exceeded your current quota|credit balance/i.test(t) && status !== 401) return { status: 502, message: cfg.label + ' account has no credit or quota left. Add billing / credit to the ' + cfg.label + ' account.' };
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|invalid x-api-key|Incorrect API key/i.test(t)) return { status: 502, message: 'AI credentials were rejected. Check ' + cfg.keyName + '.' };
  if (status === 404) return { status: 502, message: 'AI model "' + cfg.model + '" was not found. Check ' + cfg.modelEnv + '.' };
  if (status === 429 || status === 529 || status === 503) return { status: 503, message: 'The AI service is busy. Please try again in a moment.' };
  if (status === 400 && /model/i.test(t) && /not (found|supported)|does not exist|invalid/i.test(t)) return { status: 502, message: 'AI model "' + cfg.model + '" was rejected. Check ' + cfg.modelEnv + '.' };
  return { status: 502, message: 'The AI service returned an error (' + status + ').' };
}

/** Handles one parsed stream event; calls onText(text) and fills state.stop / state.error. */
function handleEvent(cfg, ev, onText, state) {
  if (cfg.provider === 'anthropic') {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') onText(ev.delta.text);
    else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) state.stop = ev.delta.stop_reason === 'max_tokens' ? 'max_tokens' : '';
    else if (ev.type === 'error') state.error = (ev.error && ev.error.message) || 'The AI service reported an error.';
    return;
  }
  if (cfg.provider === 'openai') {
    if (ev.error) { state.error = ev.error.message || 'The AI service reported an error.'; return; }
    const ch = ev.choices && ev.choices[0];
    if (!ch) return;
    if (ch.delta && typeof ch.delta.content === 'string' && ch.delta.content) onText(ch.delta.content);
    if (ch.finish_reason === 'length') state.stop = 'max_tokens';
    else if (ch.finish_reason === 'content_filter') state.error = 'The AI blocked this response. Try a different image or wording.';
    return;
  }
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
async function open({ system, messages, maxTokens, signal, quality }) {
  const cfg = info(quality);
  if (!cfg.configured) return { ok: false, status: 500, message: 'AI service is not configured. Set ' + cfg.keyName + ' in Vercel (or choose another provider with AI_PROVIDER).' };
  // If a model name is not available on this account (404 / "model not found"), try other current models of the same
  // provider before giving up. A model the owner set in Vercel (<PROVIDER>_MODEL...) is tried first.
  const tryModels = [cfg.model].concat((FALLBACK_MODELS[cfg.provider] || []).filter((m) => m !== cfg.model));
  let up, used = cfg;
  for (let i = 0; i < tryModels.length; i++) {
    used = { ...cfg, model: tryModels[i] };
    const reqd = buildRequest(used, { system, messages, maxTokens });
    try {
      up = await fetch(reqd.url, { method: 'POST', signal, headers: reqd.headers, body: JSON.stringify(reqd.body) });
    } catch (e) {
      return { ok: false, status: 502, message: 'Could not reach the AI service. Please try again.' };
    }
    if (up.ok) break;
    const text = await up.text().catch(() => '');
    console.error('AI upstream error', cfg.provider, used.model, up.status, text.slice(0, 400));
    const modelProblem = up.status === 404 || (up.status === 400 && /model/i.test(text) && /not (found|supported)|does not exist|invalid/i.test(text));
    if (modelProblem && i < tryModels.length - 1) continue;
    const f = friendlyError(used, up.status, text);
    return { ok: false, status: f.status, message: f.message };
  }
  return {
    ok: true,
    async read(onText) {
      const state = { stop: '', error: '' };
      const dec = new TextDecoder();
      let buf = '';
      const block = (b) => {
        let data = '';
        for (const l of b.split('\n')) if (l.startsWith('data:')) data += l.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try { handleEvent(cfg, JSON.parse(data), onText, state); } catch (e) { /* ignore a broken event */ }
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
        if (!(signal && signal.aborted)) state.error = state.error || 'The connection to the AI service was interrupted.';
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

module.exports = { info, open, ask, QUALITY, outputTokens, LABEL, KEY_NAME, DEFAULT_MODEL };
