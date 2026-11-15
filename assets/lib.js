// DRAW2CODE AI — pure helpers (no DOM, no Firebase) so they can be unit-tested in Node.

export const FRAMEWORKS = {
  bootstrap: { label: 'HTML + CSS + JS + Bootstrap', short: 'Bootstrap', files: ['index.html', 'style.css', 'script.js'] },
  vanilla: { label: 'HTML + CSS + JavaScript', short: 'Vanilla', files: ['index.html', 'style.css', 'script.js'] },
  react: { label: 'React + CSS', short: 'React', files: ['index.html', 'style.css', 'app.jsx'] },
};

export const INPUT_TYPES = {
  screenshot: 'Full website screenshot',
  sketch: 'Hand-drawn sketch',
  component: 'Single UI component',
};

export function slugify(s) {
  const out = String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'project';
}

export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

export function byteLength(str) {
  return new TextEncoder().encode(String(str || '')).length;
}

export function totalBytes(files) {
  return (files || []).reduce((a, f) => a + byteLength(f.content), 0);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripFences(text) {
  let t = String(text || '');
  t = t.replace(/^\s*```[\w+-]*[ \t]*\r?\n/, '');
  t = t.replace(/\r?\n```[ \t]*\s*$/, '\n');
  return t;
}

function cleanName(raw) {
  let n = String(raw || '').replace(/[`*"']/g, '').trim();
  n = n.split(/[\\/]/).pop() || '';
  n = n.replace(/[^\w.\-]/g, '');
  return n || 'file.txt';
}

/**
 * Parse model output of the form:
 * ===FILE: index.html===
 * ...
 * ===FILE: style.css===
 * ...
 * Works on partial (streaming) text as well.
 */
export function parseFiles(raw, { streaming = false } = {}) {
  const text = String(raw || '');
  const re = /^={3,}[ \t]*FILE:[ \t]*(.+?)[ \t]*={3,}[ \t]*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ name: cleanName(m[1]), start: m.index, end: re.lastIndex });
  return marks.map((mk, i) => {
    const next = marks[i + 1];
    let content = text.slice(mk.end, next ? next.start : text.length).replace(/^\r?\n/, '');
    if (streaming && !next) content = content.replace(/\n=+[^\n]*$/, '');
    content = stripFences(content);
    if (!streaming) content = content.replace(/\s+$/, '') + '\n';
    return { name: mk.name, content };
  });
}

const STORAGE_SHIM =
  '<script>(function(){function mk(){var m={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}}}' +
  '["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("x")}catch(e){try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch(e2){}}})})();</script>';


const ERROR_SHIM =
  '<script>(function(){function r(m,l,s){try{parent.postMessage({d2c:"error",message:String(m||"Unknown error"),line:l||0,stack:String(s||"").slice(0,1500)},"*")}catch(e){}}' +
  'window.addEventListener("error",function(e){r(e.message,e.lineno,e.error&&e.error.stack)});' +
  'window.addEventListener("unhandledrejection",function(e){var x=e.reason;r("Unhandled promise: "+(x&&x.message||x),0,x&&x.stack)});' +
  'var ce=console.error;console.error=function(){try{r("console.error: "+Array.prototype.slice.call(arguments).map(String).join(" "),0,"")}catch(e){}return ce.apply(console,arguments)}})();</script>';

/** Inline css/js files into the html so it can run in a sandboxed iframe (srcdoc). */
export function buildPreview(files) {
  const list = files || [];
  const htmlFile = list.find((f) => /\.html?$/i.test(f.name));
  let html = htmlFile ? htmlFile.content : '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

  for (const f of list) {
    if (f === htmlFile) continue;
    const n = escapeRe(f.name);
    let replaced = false;
    if (/\.css$/i.test(f.name)) {
      const re = new RegExp('<link\\b[^>]*href=["\'](?:\\./)?' + n + '["\'][^>]*>', 'gi');
      html = html.replace(re, () => {
        replaced = true;
        return '<style>\n' + f.content + '\n</style>';
      });
      if (!replaced) {
        const block = '<style>\n' + f.content + '\n</style>';
        html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => block + '\n</head>') : block + html;
      }
    } else {
      const re = new RegExp('<script\\b([^>]*?)\\bsrc=["\'](?:\\./)?' + n + '["\']([^>]*)>\\s*</script>', 'gi');
      const safe = f.content.replace(/<\/script/gi, '<\\/script');
      html = html.replace(re, (_, a, b) => {
        replaced = true;
        return '<script' + a + b + '>\n' + safe + '\n</script>';
      });
      if (!replaced) {
        const type = /\.jsx$/i.test(f.name) ? ' type="text/babel"' : '';
        const block = '<script' + type + '>\n' + safe + '\n</script>';
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => block + '\n</body>') : html + block;
      }
    }
  }

  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + STORAGE_SHIM + ERROR_SHIM) : STORAGE_SHIM + ERROR_SHIM + html;
  return html;
}

/* ---------- Minimal ZIP writer (stored, no compression) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  for (const f of files) {
    const nameB = enc.encode(f.name);
    const data = enc.encode(f.content);
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameB.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nameB, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);

    offset += 30 + nameB.length + data.length;
  }

  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const total = all.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
