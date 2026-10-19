/**
 * Rich text for artist / composer bios (bold, italic, underline, links, lists, quotes, line breaks).
 *
 * A bio is stored as a small, sanitized HTML string whose top level is always blocks (<p>, <ul>, <ol>,
 * <blockquote>). Older bios are plain text with newlines; they are recognised (see looksLikeHtml) and rendered
 * as paragraphs, so nothing has to be migrated.
 *
 * The sanitizer is deliberately NOT a "strip the bad parts" filter. It tokenises the input and then *rebuilds*
 * the output from scratch: every text run is escaped, only a fixed set of tags is ever emitted (with no
 * attributes except a validated href on <a>), so nothing from the input can reach the output as markup.
 * Pure JS with no runtime APIs, so it runs the same in the Worker, in Pages Functions and under Node (tests).
 *
 * Shared by: admin + owner writes (normalizeBio), the public API (bioPlain / bioToHtml) and the SSR pages.
 */

export const BIO_TEXT_MAX = 5000;   // visible characters
export const BIO_HTML_MAX = 20000;  // stored markup, a guard against pathological nesting
const HREF_MAX = 2000;

// Same allowlist as worker/lib/sanitizeHtml.js: a real web or mail address, never javascript: / data:.
const SAFE_HREF = /^(https?:|mailto:)/i;

const INLINE = { b: 'strong', strong: 'strong', i: 'em', em: 'em', u: 'u', s: 's', strike: 's', del: 's' };
// Tags that end the current paragraph (and whose own text still counts, like a pasted <div>).
const BLOCKISH = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'address',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'dl', 'dt', 'dd',
  'li', 'ul', 'ol', 'blockquote',
]);
// Content that must vanish entirely, not surface as text.
const DROP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'iframe', 'object', 'embed', 'svg', 'math', 'textarea', 'select']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

export function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const MAX_TAG_LENGTH = 2048;

/** Reads a tag starting at html[i] === '<' → { end, close, name, attrs } or null when it isn't a well-formed tag. Linear, bounded. */
function readTag(html, i) {
  const limit = Math.min(html.length, i + MAX_TAG_LENGTH);
  let j = i + 1;
  const close = html[j] === '/';
  if (close) j++;
  if (!/[a-zA-Z]/.test(html[j] || '')) return null;
  const nameStart = j;
  while (j < limit && /[a-zA-Z0-9:-]/.test(html[j])) j++;
  const name = html.slice(nameStart, j).toLowerCase();
  const attrsStart = j;
  while (j < limit) {
    const ch = html[j];
    if (ch === '>') return { end: j + 1, close, name, attrs: html.slice(attrsStart, j) };
    if (ch === '"' || ch === "'") {
      const q = html.indexOf(ch, j + 1);
      if (q === -1 || q >= limit) return null;
      j = q + 1;
    } else j++;
  }
  return null;
}
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function readHref(attrSource) {
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrSource))) {
    if (m[1].toLowerCase() === 'href') {
      const href = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim();
      return href && href.length <= HREF_MAX && SAFE_HREF.test(href) && !/[\u0000-\u001f\u007f\s]/.test(href) ? href : '';
    }
  }
  return '';
}

/** Tokenises `html` into { text } / { tag, close, attrs } items. Anything that isn't a well-formed tag is text. */
function* tokenize(html) {
  let i = 0;
  let textStart = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] !== '<') { i++; continue; }
    if (html.startsWith('<!--', i)) {
      if (i > textStart) yield { text: html.slice(textStart, i) };
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      textStart = i;
      continue;
    }
    const tag = readTag(html, i);
    if (!tag) { i++; continue; } // a lone "<" is just text
    if (i > textStart) yield { text: html.slice(textStart, i) };
    yield { tag: tag.name, close: tag.close, attrs: tag.attrs };
    i = tag.end;
    textStart = i;
  }
  if (n > textStart) yield { text: html.slice(textStart) };
}

/** True when `s` is one of our stored rich bios (as opposed to a legacy plain-text one). */
export function looksLikeHtml(s) {
  return /^\s*<(p|ul|ol|blockquote)[\s>]/i.test(String(s || ''));
}

/** Turns any HTML into the canonical, safe bio markup. */
export function sanitizeBioHtml(input) {
  const html = String(input || '');
  const blocks = []; // { type: 'p' | 'li:ul' | 'li:ol' | 'quote', html }
  let cur = null;
  let stack = []; // open inline elements: { tag, emitted }
  const lists = []; // 'ul' | 'ol' for each open list (nested lists are flattened into the outer one)
  let quoteDepth = 0;
  let dropUntil = null;

  const closeInline = () => {
    let out = '';
    while (stack.length) { const e = stack.pop(); if (e.emitted) out += `</${e.tag}>`; }
    return out;
  };
  const finish = () => {
    if (!cur) return;
    cur.html += closeInline();
    const visible = cur.html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    const trimmed = cur.html.replace(/^(?:\s|<br>)+/, '').replace(/(?:\s|<br>)+$/, '');
    if (visible && trimmed) {
      const prev = blocks[blocks.length - 1];
      if (cur.type === 'quote' && prev && prev.type === 'quote') prev.html += `<br>${trimmed}`; // consecutive quoted lines = one quote
      else blocks.push({ type: cur.type, html: trimmed });
    }
    cur = null;
  };
  const ensure = () => {
    if (cur) return;
    const type = lists.length ? `li:${lists[0]}` : quoteDepth ? 'quote' : 'p';
    cur = { type, html: '' };
  };

  for (const tok of tokenize(html)) {
    if (dropUntil) {
      if (tok.tag === dropUntil && tok.close) dropUntil = null;
      continue;
    }
    if (tok.text !== undefined) {
      const text = decodeEntities(tok.text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ');
      if (!text.trim() && !cur) continue; // whitespace between blocks
      ensure();
      cur.html += escapeText(text);
      continue;
    }
    const { tag, close } = tok;
    if (DROP.has(tag)) { if (!close && !/\/\s*$/.test(tok.attrs)) dropUntil = tag; continue; }

    if (INLINE[tag]) {
      const out = INLINE[tag];
      if (!close) { ensure(); cur.html += `<${out}>`; stack.push({ tag: out, emitted: true }); }
      else {
        const at = stack.map((e) => e.tag).lastIndexOf(out);
        if (at !== -1) { while (stack.length > at) { const e = stack.pop(); if (e.emitted) cur.html += `</${e.tag}>`; } }
      }
      continue;
    }
    if (tag === 'a') {
      if (!close) {
        ensure();
        const href = readHref(tok.attrs);
        if (href) { cur.html += `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer nofollow">`; stack.push({ tag: 'a', emitted: true }); }
        else stack.push({ tag: 'a', emitted: false }); // unsafe/missing href: keep the words, drop the link
      } else {
        const at = stack.map((e) => e.tag).lastIndexOf('a');
        if (at !== -1 && cur) { while (stack.length > at) { const e = stack.pop(); if (e.emitted) cur.html += `</${e.tag}>`; } }
      }
      continue;
    }
    if (tag === 'br') { if (!close) { ensure(); cur.html += '<br>'; } continue; }

    if (BLOCKISH.has(tag)) {
      finish();
      if (tag === 'ul' || tag === 'ol') { if (!close) lists.push(tag); else lists.pop(); }
      else if (tag === 'blockquote') { quoteDepth = Math.max(0, quoteDepth + (close ? -1 : 1)); }
      continue;
    }
    // Any other tag (span, font, img, …): ignored, its text is kept.
  }
  finish();

  let out = '';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type.startsWith('li:')) {
      const list = b.type.slice(3);
      if (i === 0 || blocks[i - 1].type !== b.type) out += `<${list}>`;
      out += `<li>${b.html}</li>`;
      if (i === blocks.length - 1 || blocks[i + 1].type !== b.type) out += `</${list}>`;
    } else if (b.type === 'quote') out += `<blockquote>${b.html}</blockquote>`;
    else out += `<p>${b.html}</p>`;
  }
  return out;
}

/** A legacy plain-text bio as paragraphs: blank line = new paragraph, single newline = line break. */
export function plainToHtml(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${para.split('\n').map((l) => escapeText(l.trim())).join('<br>')}</p>`)
    .join('');
}

/** Whatever is stored (rich or legacy) → safe HTML for display or for loading into the editor. */
export function bioToHtml(stored) {
  const s = String(stored || '').trim();
  if (!s) return '';
  return looksLikeHtml(s) ? sanitizeBioHtml(s) : plainToHtml(s);
}

/** Visible text of bio HTML: paragraphs separated by a blank line, list items bulleted, <br> as a newline. */
export function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<li>/gi, '• ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|blockquote)>/gi, '\n\n')
      .replace(/<[^>]*>/g, '')
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\n\n(?=• )/g, '\n').trim();
}

/** Whatever is stored → plain text (public API `bio`, meta descriptions, search). Legacy bios pass through unchanged. */
export function bioPlain(stored) {
  const s = String(stored || '').trim();
  if (!s) return '';
  return looksLikeHtml(s) ? htmlToText(sanitizeBioHtml(s)) : s;
}

/**
 * Validates and canonicalises a bio from an admin or an owner. → { ok: true, value } (value null when empty)
 * | { ok: false, error }. Plain-text input (an old client / direct API call) is converted to paragraphs.
 */
export function normalizeBio(input) {
  if (input === undefined || input === null || input === '') return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false, error: 'bio must be text' };
  if (input.length > BIO_HTML_MAX * 5) return { ok: false, error: 'bio is too long' }; // refuse before parsing anything huge
  const html = bioToHtml(input);
  const text = htmlToText(html);
  if (!text) return { ok: true, value: null };
  if (text.length > BIO_TEXT_MAX) return { ok: false, error: `bio is too long (max ${BIO_TEXT_MAX} characters)` };
  if (html.length > BIO_HTML_MAX) return { ok: false, error: 'bio has too much formatting — simplify it' };
  return { ok: true, value: html };
}

/** Public-API shape of a person row: `bio` stays plain text (so older clients keep working); `bio_html` is the rich version. */
export function shapeBio(row, { withHtml = false } = {}) {
  if (!row) return row;
  const plain = bioPlain(row.bio);
  const out = { ...row, bio: row.bio ? plain : row.bio };
  if (withHtml) out.bio_html = bioToHtml(row.bio);
  return out;
}
