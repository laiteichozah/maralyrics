// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — photo cropper                    │
// └───────────────────────────────────────────────┘
// Shown whenever someone chooses a profile photo: a square window onto the picture that they drag to frame the face and
// zoom with a slider (or the mouse wheel, the +/- buttons, the arrow keys). Resolves to a square JPEG data: URL, or null
// when they cancel. Used by the account page and the artist / composer profile editor. Needs I18n, loaded before the page script.
//
//   const dataUrl = await PhotoCropper.open(file, { size: 256 });   // → 'data:image/jpeg;base64,…' | null | throws if the file isn't an image
const PhotoCropper = (() => {
  'use strict';
  const MAX_ZOOM = 4;
  const STEP_KEY = 12;    // pixels moved by an arrow key
  const STEP_ZOOM = 0.25; // zoom change of the +/- buttons

  const t = (key, fallback) => {
    try { const v = I18n.t(key); return v && v !== key ? v : fallback; } catch { return fallback; }
  };

  function loadImage(file) {
    const url = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')); };
      img.src = url;
    });
  }

  /** Opens the cropper for `file`. Resolves with a square JPEG data URL, or null if cancelled. */
  async function open(file, { size = 256, quality = 0.85 } = {}) {
    const { img, url } = await loadImage(file);
    const natW = img.naturalWidth || img.width;
    const natH = img.naturalHeight || img.height;
    if (!natW || !natH) { URL.revokeObjectURL(url); throw new Error('not an image'); }
    const opener = document.activeElement;

    return new Promise((resolve) => {
      const root = document.createElement('div');
      root.className = 'crop';
      root.innerHTML = `
        <div class="crop__backdrop" data-crop-cancel></div>
        <section class="crop__panel" role="dialog" aria-modal="true" aria-labelledby="cropTitle" tabindex="-1">
          <h2 class="crop__title" id="cropTitle"></h2>
          <p class="crop__hint"></p>
          <div class="crop__stage" tabindex="0" role="application"><img class="crop__img" alt="" draggable="false" /><div class="crop__mask" aria-hidden="true"></div></div>
          <div class="crop__zoom">
            <button type="button" class="crop__step" data-crop-out></button>
            <input type="range" class="crop__range" min="1" max="${MAX_ZOOM}" step="0.01" value="1" />
            <button type="button" class="crop__step" data-crop-in></button>
          </div>
          <div class="crop__actions">
            <button type="button" class="acct-btn acct-btn--quiet" data-crop-cancel></button>
            <button type="button" class="acct-btn" data-crop-use></button>
          </div>
        </section>`;
      const q = (sel) => root.querySelector(sel);
      const panel = q('.crop__panel');
      const stage = q('.crop__stage');
      const image = q('.crop__img');
      const range = q('.crop__range');
      q('.crop__title').textContent = t('crop.title', 'Crop your photo');
      q('.crop__hint').textContent = t('crop.hint', 'Drag the photo to frame it, and zoom with the slider.');
      stage.setAttribute('aria-label', t('crop.stage_aria', 'Photo. Use the arrow keys to move it and plus and minus to zoom.'));
      range.setAttribute('aria-label', t('crop.zoom', 'Zoom'));
      const out = q('[data-crop-out]'); out.textContent = '−'; out.setAttribute('aria-label', t('crop.zoom_out', 'Zoom out'));
      const inn = q('[data-crop-in]'); inn.textContent = '+'; inn.setAttribute('aria-label', t('crop.zoom_in', 'Zoom in'));
      root.querySelectorAll('[data-crop-cancel]').forEach((b) => { if (b.tagName === 'BUTTON') b.textContent = t('crop.cancel', 'Cancel'); });
      q('[data-crop-use]').textContent = t('crop.use', 'Use photo');
      image.src = url;

      // The picture is laid out in the stage's own pixels. `zoom` 1 = the shorter side exactly fills the square window.
      let S = 300;      // side of the square window, in px (measured after the dialog is shown)
      let zoom = 1;
      let ox = 0, oy = 0; // where the picture's top-left corner sits inside the window (≤ 0: the picture always covers it)
      const base = () => S / Math.min(natW, natH);
      const scale = () => base() * zoom;
      const clamp = () => {
        const w = natW * scale(), h = natH * scale();
        ox = Math.min(0, Math.max(S - w, ox));
        oy = Math.min(0, Math.max(S - h, oy));
      };
      const draw = () => {
        clamp();
        image.style.width = `${natW * scale()}px`;
        image.style.height = `${natH * scale()}px`;
        image.style.transform = `translate(${ox}px, ${oy}px)`;
        range.value = String(zoom);
      };
      /** Zooms keeping the point under the window's centre where it is. */
      const setZoom = (next) => {
        next = Math.min(MAX_ZOOM, Math.max(1, next));
        const cx = (S / 2 - ox) / scale();
        const cy = (S / 2 - oy) / scale();
        zoom = next;
        ox = S / 2 - cx * scale();
        oy = S / 2 - cy * scale();
        draw();
      };

      // Dragging (mouse, finger or pen)
      let drag = null;
      stage.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button > 0) return;
        drag = { x: e.clientX, y: e.clientY, ox, oy, id: e.pointerId };
        try { stage.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        stage.classList.add('is-dragging');
        e.preventDefault();
      });
      stage.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        ox = drag.ox + (e.clientX - drag.x);
        oy = drag.oy + (e.clientY - drag.y);
        draw();
      });
      const endDrag = (e) => { if (drag && e.pointerId === drag.id) { drag = null; stage.classList.remove('is-dragging'); } };
      stage.addEventListener('pointerup', endDrag);
      stage.addEventListener('pointercancel', endDrag);
      stage.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }, { passive: false });
      range.addEventListener('input', () => setZoom(Number(range.value)));
      out.addEventListener('click', () => setZoom(zoom - STEP_ZOOM));
      inn.addEventListener('click', () => setZoom(zoom + STEP_ZOOM));

      // Keyboard: arrows move the picture the way they point, + / - zoom, Enter uses it, Escape cancels.
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(null); return; }
        if (e.target === range) return;
        const move = { ArrowLeft: [-STEP_KEY, 0], ArrowRight: [STEP_KEY, 0], ArrowUp: [0, -STEP_KEY], ArrowDown: [0, STEP_KEY] }[e.key];
        if (move && (e.target === stage || e.target === panel)) { e.preventDefault(); ox += move[0]; oy += move[1]; draw(); return; }
        if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom + STEP_ZOOM); }
        else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(zoom - STEP_ZOOM); }
        else if (e.key === 'Tab') {
          // keep the focus inside the dialog
          const items = [...panel.querySelectorAll('button, input, [tabindex="0"]')].filter((el) => !el.disabled);
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      document.addEventListener('keydown', onKey, true);

      function result() {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // JPEG has no alpha
        ctx.fillRect(0, 0, size, size);
        const s = scale();
        ctx.drawImage(img, -ox / s, -oy / s, S / s, S / s, 0, 0, size, size);
        return canvas.toDataURL('image/jpeg', quality);
      }

      // A phone turned sideways changes the window's size: keep the same part of the picture in view.
      function onResize() { const was = S; S = stage.clientWidth || was; if (S !== was) { ox *= S / was; oy *= S / was; draw(); } }

      function finish(value) {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onResize);
        root.remove();
        document.body.classList.remove('crop-open');
        URL.revokeObjectURL(url);
        if (opener && opener.focus) { try { opener.focus(); } catch { /* gone */ } }
        resolve(value);
      }
      root.querySelectorAll('[data-crop-cancel]').forEach((el) => el.addEventListener('click', () => finish(null)));
      q('[data-crop-use]').addEventListener('click', () => finish(result()));

      document.body.appendChild(root);
      document.body.classList.add('crop-open');
      S = stage.clientWidth || 300;
      draw();
      ox = (S - natW * scale()) / 2; // start centred
      oy = (S - natH * scale()) / 2;
      draw();
      stage.focus();
      window.addEventListener('resize', onResize);
    });
  }

  return { open };
})();
