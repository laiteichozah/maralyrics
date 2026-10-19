// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — rich text for artist / composer bios │
// └───────────────────────────────────────────────┘
// A tiny, dependency-free editor (a contenteditable div + toolbar) and the helpers around it. Used by the admin
// dashboard and by the claimed-profile editor, so both behave the same.
//
//   RichText.mount(container, { labels, placeholder, editorClass, onChange })  → editor API (see bottom of mount)
//   RichText.clean(html)       allowlist-clean HTML for display (defence in depth: the server already sanitizes)
//   RichText.fromStored(bio)   stored bio (rich HTML, or an old plain-text one) → clean HTML
//   RichText.toText(html)      visible text, for counting characters
//
// What a bio can contain: bold, italic, underline, links (http/https/mailto), bullet + numbered lists, quotes,
// paragraphs and line breaks. worker/lib/richText.js is the authority on the server side and enforces the same set.
(() => {
  'use strict';

  const SAFE_HREF = /^(https?:|mailto:)/i;
  const MAP = { B: 'strong', STRONG: 'strong', I: 'em', EM: 'em', U: 'u', S: 's', STRIKE: 's', DEL: 's', UL: 'ul', OL: 'ol', LI: 'li', BLOCKQUOTE: 'blockquote', P: 'p' };
  const AS_PARAGRAPH = new Set(['DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'SECTION', 'ARTICLE', 'TR']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEXTAREA', 'SELECT']);

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function walk(node, out) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out.push(esc(child.nodeValue)); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toUpperCase();
      if (DROP.has(tag)) continue;
      if (tag === 'BR') { out.push('<br>'); continue; }
      if (tag === 'A') {
        const href = (child.getAttribute('href') || '').trim();
        if (SAFE_HREF.test(href) && !/[\u0000-\u001f\u007f\s]/.test(href)) {
          out.push(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">`);
          walk(child, out);
          out.push('</a>');
        } else walk(child, out);
        continue;
      }
      const mapped = MAP[tag] || (AS_PARAGRAPH.has(tag) ? 'p' : null);
      if (mapped) { out.push(`<${mapped}>`); walk(child, out); out.push(`</${mapped}>`); } else walk(child, out); // span, font, … keep the words
    }
  }

  /** Allowlist-clean HTML (parsed inertly in a <template>, so nothing runs or loads while we look at it). */
  function clean(html) {
    if (!html) return '';
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html);
    const out = [];
    walk(tpl.content, out);
    return out.join('');
  }

  const looksLikeHtml = (s) => /^\s*<(p|ul|ol|blockquote)[\s>]/i.test(String(s || ''));

  function plainToHtml(text) {
    return String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      .map((p) => `<p>${p.split('\n').map((l) => esc(l.trim()).replace(/&quot;/g, '"')).join('<br>')}</p>`).join('');
  }

  /** A stored bio (rich HTML, or an old plain-text one) → clean HTML. */
  function fromStored(stored) {
    const s = String(stored || '').trim();
    if (!s) return '';
    return looksLikeHtml(s) ? clean(s) : plainToHtml(s);
  }

  function toText(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|blockquote)>/gi, '</$1>\n');
    return (tpl.content.textContent || '').trim();
  }

  // ── Editor ─────────────────────────────────────
  const ICONS = {
    bold: '<b>B</b>',
    italic: '<i>I</i>',
    underline: '<u>U</u>',
    link: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>',
    unlink: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/></svg>',
    ul: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>',
    ol: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="2" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="2" y="14" font-size="7" fill="currentColor" stroke="none">2</text><text x="2" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg>',
    quote: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 17h4l2-4V7H4v6h3zm10 0h4l2-4V7h-6v6h3z"/></svg>',
    clear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  };
  const DEFAULT_LABELS = {
    bold: 'Bold (Ctrl+B)', italic: 'Italic (Ctrl+I)', underline: 'Underline (Ctrl+U)', link: 'Add link (Ctrl+K)', unlink: 'Remove link',
    ul: 'Bullet list', ol: 'Numbered list', quote: 'Quote', clear: 'Clear formatting', toolbar: 'Text formatting',
    link_prompt: 'Link address (https://…)', link_invalid: 'That doesn\'t look like a web or email address.', hint: 'Enter starts a new paragraph. Shift+Enter starts a new line.',
  };
  const BUTTONS = [
    ['bold', 'bold'], ['italic', 'italic'], ['underline', 'underline'], '|',
    ['link', 'link'], ['unlink', 'unlink'], '|',
    ['ul', 'insertUnorderedList'], ['ol', 'insertOrderedList'], ['quote', 'quote'], '|',
    ['clear', 'removeFormat'],
  ];

  /** Turns what a person typed into the link box into a safe URL, or '' if it can't be one. */
  function normalizeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    if (/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(u)) u = `mailto:${u}`;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(u) && /^[^\s/]+\.[^\s/]+/.test(u)) u = `https://${u}`;
    return SAFE_HREF.test(u) && !/\s/.test(u) && u.length <= 2000 ? u : '';
  }

  /**
   * Builds the toolbar + editable area inside `container` and returns
   *   { getHtml, setHtml, getText, isEmpty, setDisabled, focus, el }
   * opts: labels (partial override of DEFAULT_LABELS, for translation), placeholder, editorClass (extra classes on
   * the editable area), onChange({ text, length, user }) fired on every edit (user:false when the page itself set the content), showHint (default true).
   */
  function mount(container, opts = {}) {
    const labels = { ...DEFAULT_LABELS, ...(opts.labels || {}) };
    container.classList.add('rte');
    container.innerHTML = '';

    const toolbar = document.createElement('div');
    toolbar.className = 'rte-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', labels.toolbar);
    const buttons = {};
    for (const item of BUTTONS) {
      if (item === '|') { const sep = document.createElement('span'); sep.className = 'rte-toolbar__sep'; toolbar.appendChild(sep); continue; }
      const [name, cmd] = item;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rte-toolbar__btn';
      b.dataset.cmd = cmd;
      b.dataset.name = name;
      b.title = labels[name];
      b.setAttribute('aria-label', labels[name]);
      b.innerHTML = ICONS[name];
      buttons[name] = b;
      toolbar.appendChild(b);
    }

    const editor = document.createElement('div');
    editor.className = `rte-editor ${opts.editorClass || ''}`.trim();
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    if (opts.placeholder) editor.dataset.placeholder = opts.placeholder;

    container.append(toolbar, editor);
    if (opts.showHint !== false) {
      const hint = document.createElement('small');
      hint.className = 'rte-hint';
      hint.textContent = labels.hint;
      container.appendChild(hint);
    }

    const exec = (cmd, value = null) => { try { return document.execCommand(cmd, false, value); } catch { return false; } };
    const state = (cmd) => { try { return document.queryCommandState(cmd); } catch { return false; } };
    const inEditor = () => { const s = window.getSelection(); return s && s.rangeCount && editor.contains(s.anchorNode); };
    const closestAnchor = () => {
      const s = window.getSelection();
      let n = s && s.anchorNode;
      while (n && n !== editor) { if (n.nodeType === 1 && n.tagName === 'A') return n; n = n.parentNode; }
      return null;
    };
    const getText = () => toText(editor.innerHTML);
    const syncEmpty = () => editor.classList.toggle('is-empty', !getText());
    const changed = (user = true) => { syncEmpty(); if (opts.onChange) { const text = getText(); opts.onChange({ text, length: text.length, user }); } };

    function refreshToolbar() {
      if (!inEditor()) return;
      for (const name of ['bold', 'italic', 'underline']) buttons[name].classList.toggle('active', state(name));
      buttons.ul.classList.toggle('active', state('insertUnorderedList'));
      buttons.ol.classList.toggle('active', state('insertOrderedList'));
      let block = '';
      try { block = String(document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch { /* unsupported */ }
      buttons.quote.classList.toggle('active', block === 'blockquote');
      buttons.link.classList.toggle('active', !!closestAnchor());
    }
    document.addEventListener('selectionchange', refreshToolbar);

    function addLink() {
      // The prompt steals focus; remember where the selection was and put it back afterwards.
      const sel = window.getSelection();
      const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const existing = closestAnchor();
      const typed = window.prompt(labels.link_prompt, existing ? existing.getAttribute('href') || 'https://' : 'https://');
      if (typed === null) return;
      editor.focus();
      if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
      if (!String(typed).trim() || String(typed).trim() === 'https://') { exec('unlink'); return; }
      const url = normalizeUrl(typed);
      if (!url) { (window.Toast ? () => window.Toast.show(labels.link_invalid, { type: 'error' }) : () => window.alert(labels.link_invalid))(); return; }
      if (sel.isCollapsed && !existing) exec('insertHTML', `<a href="${esc(url)}">${esc(url.replace(/^mailto:/i, ''))}</a>`);
      else exec('createLink', url);
    }

    function run(name, cmd) {
      editor.focus();
      if (name === 'link') addLink();
      else if (name === 'unlink') exec('unlink');
      else if (name === 'quote') exec('formatBlock', String(document.queryCommandValue('formatBlock') || '').toLowerCase() === 'blockquote' ? 'p' : 'blockquote');
      else if (name === 'clear') { exec('removeFormat'); exec('unlink'); exec('formatBlock', 'p'); }
      else exec(cmd);
      changed();
      refreshToolbar();
    }

    // mousedown (not click) so the editor keeps its selection while a toolbar button is pressed.
    toolbar.addEventListener('mousedown', (e) => { if (e.target.closest('.rte-toolbar__btn')) e.preventDefault(); });
    toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('.rte-toolbar__btn');
      if (b && !b.disabled) run(b.dataset.name, b.dataset.cmd);
    });

    editor.addEventListener('focus', () => { exec('defaultParagraphSeparator', 'p'); });
    editor.addEventListener('input', () => changed());
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); addLink(); }
    });

    // Pasted text keeps its basic formatting (bold, links, lists…) but never brings colours, fonts or scripts along.
    editor.addEventListener('paste', (e) => {
      const data = e.clipboardData;
      if (!data) return;
      e.preventDefault();
      const html = data.getData('text/html');
      if (html) exec('insertHTML', clean(html));
      else exec('insertText', data.getData('text/plain'));
      changed();
    });
    // Dropped content goes in as plain text for the same reason.
    editor.addEventListener('drop', (e) => {
      e.preventDefault();
      const text = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (!text) return;
      editor.focus();
      const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
      if (range) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
      exec('insertText', text);
      changed();
    });

    syncEmpty();
    return {
      el: editor,
      getHtml() { syncEmpty(); return getText() ? clean(editor.innerHTML) : ''; },
      setHtml(stored) { editor.innerHTML = fromStored(stored); changed(false); }, // programmatic: onChange gets user:false
      getText,
      isEmpty: () => !getText(),
      setDisabled(disabled) {
        editor.contentEditable = disabled ? 'false' : 'true';
        for (const b of Object.values(buttons)) b.disabled = !!disabled;
      },
      focus() { editor.focus(); },
    };
  }

  window.RichText = { mount, clean, fromStored, toText, plainToHtml, looksLikeHtml, normalizeUrl };
})();
