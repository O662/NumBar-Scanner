/* NumBar Scanner — point the camera at a screen or label, read the UPC digits,
   turn them into a scannable barcode. Everything runs in the browser. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    cameraView: $('camera-view'),
    resultView: $('result-view'),
    video: $('video'),
    reticleBox: document.querySelector('.reticle-box'),
    focusRing: $('focus-ring'),
    scanBtn: $('scan-btn'),
    manualBtn: $('manual-btn'),
    flipBtn: $('flip-btn'),
    clearBtn: $('clear-btn'),
    status: $('status'),
    statusText: $('status-text'),
    cameraError: $('camera-error'),
    digits: $('digits'),
    barcode: $('barcode'),
    barcodeValue: $('barcode-value'),
    barcodeError: $('barcode-error'),
    format: $('format'),
    formatUsed: $('format-used'),
    themeBtn: $('theme-btn'),
    themeMeta: document.querySelector('meta[name="theme-color"]'),
  };

  let stream = null;
  let videoTrack = null;
  let facingMode = 'environment';
  let ocrWorkerPromise = null;
  let busy = false;

  /* ─────────────────────────── theme ───────────────────────────
     The <head> script has already picked the starting theme; this keeps the
     button, the browser chrome colour and localStorage in step after that. */

  const THEME_KEY = 'numbar-theme';
  const THEME_META = { dark: '#000000', light: '#ffffff' };

  function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (el.themeMeta) el.themeMeta.setAttribute('content', THEME_META[theme]);
    el.themeBtn.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
    );
  }

  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* private mode: this session only */ }
  }

  /* ─────────────────────────── camera ─────────────────────────── */

  async function startCamera() {
    if (!window.isSecureContext) {
      return showCameraError(
        'The camera only works over HTTPS. Open this page at its https:// address ' +
        '(or use “Type it in” to enter digits by hand).'
      );
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showCameraError('This browser has no camera API. Use “Type it in” instead.');
    }

    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      return showCameraError(
        denied
          ? 'Camera permission was blocked. Allow camera access for this site in your browser settings, then reload.'
          : 'Could not open the camera (' + (err && err.name ? err.name : 'unknown error') + '). Use “Type it in” instead.'
      );
    }

    el.cameraError.hidden = true;
    el.video.srcObject = stream;
    try { await el.video.play(); } catch (_) { /* autoplay attrs usually cover this */ }

    videoTrack = stream.getVideoTracks()[0] || null;
    await enableContinuousFocus();

    // Only offer the flip button when there is something to flip to.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      el.flipBtn.hidden = devices.filter((d) => d.kind === 'videoinput').length < 2;
    } catch (_) { /* ignore */ }

    warmUpOcr();
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    // The next camera may be a different lens with different focus capabilities.
    videoTrack = null;
    focusCaps = null;
    pinnedUntil = 0;
    clearTimeout(refocusTimer);
  }

  function showCameraError(message) {
    el.cameraError.textContent = message;
    el.cameraError.hidden = false;
    el.scanBtn.disabled = true;
  }

  /* ─────────────────────────── focus ───────────────────────────
     A UPC line has to sit close to fill the reticle, and that is exactly where
     phone cameras hunt: continuous AF keeps drifting onto whatever is behind
     the label. So we hold continuous AF as the resting state, let a tap pin the
     focus to one spot for a few seconds, and re-focus on the reticle just
     before a scan. Where the browser exposes no focus control at all (Safari
     ships none of these constraints) every call below no-ops and the tap
     handler says so once instead of pretending. */

  const REFOCUS_MS = 3000;    // how long a tapped focus point stays pinned
  const AF_SETTLE_MS = 450;   // single-shot AF reports "applied", not "converged"

  let focusCaps = null;
  let refocusTimer = null;
  let pinnedUntil = 0;
  let focusHintShown = false;

  function focusModes() {
    if (!videoTrack || !videoTrack.getCapabilities) return [];
    if (!focusCaps) {
      try { focusCaps = videoTrack.getCapabilities() || {}; } catch (_) { focusCaps = {}; }
    }
    return focusCaps.focusMode || [];
  }

  function canFocus() {
    const modes = focusModes();
    return modes.includes('single-shot') || modes.includes('continuous');
  }

  async function applyFocus(constraint) {
    if (!videoTrack) return false;
    // advanced[] so a device that doesn't understand one of these just ignores
    // it rather than failing the whole constraint set.
    try {
      await videoTrack.applyConstraints({ advanced: [constraint] });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function enableContinuousFocus() {
    if (!focusModes().includes('continuous')) return false;
    return applyFocus({ focusMode: 'continuous' });
  }

  /** Aim AF at one spot in the frame, given as normalised 0–1 coordinates. */
  async function focusAt(point) {
    if (!canFocus()) return false;
    const mode = focusModes().includes('single-shot') ? 'single-shot' : 'continuous';

    clearTimeout(refocusTimer);
    // pointsOfInterest is never advertised in getCapabilities(), so the only way
    // to learn whether a device takes one is to try, then retry without it — a
    // plain re-apply still re-triggers AF, just wherever the camera prefers.
    const applied = await applyFocus({ focusMode: mode, pointsOfInterest: [point] })
      || await applyFocus({ focusMode: mode });
    if (!applied) return false;

    // single-shot leaves focus locked, so hand it back to continuous after a beat.
    if (mode === 'single-shot') refocusTimer = setTimeout(enableContinuousFocus, REFOCUS_MS);
    return true;
  }

  function settle() {
    return new Promise((resolve) => setTimeout(resolve, AF_SETTLE_MS));
  }

  function regionCentre(region) {
    return {
      x: (region.sx + region.sw / 2) / region.vw,
      y: (region.sy + region.sh / 2) / region.vh,
    };
  }

  function showFocusRing(clientX, clientY) {
    const view = el.cameraView.getBoundingClientRect();
    el.focusRing.style.left = (clientX - view.left) + 'px';
    el.focusRing.style.top = (clientY - view.top) + 'px';
    el.focusRing.classList.remove('is-active');
    void el.focusRing.offsetWidth;   // reflow, so a repeat tap replays the animation
    el.focusRing.classList.add('is-active');
  }

  function handleFocusTap(e) {
    if (!videoTrack || (e.target.closest && e.target.closest('button'))) return;
    const point = framePoint(e.clientX, e.clientY);
    if (!point) return;
    if (!canFocus()) return focusUnsupportedHint();

    showFocusRing(e.clientX, e.clientY);
    pinnedUntil = Date.now() + REFOCUS_MS;
    focusAt(point);
  }

  function focusUnsupportedHint() {
    if (focusHintShown) return;
    focusHintShown = true;
    setStatus(
      'This browser won’t let the page drive focus. Pull back a little — ' +
      'most phone cameras can’t focus closer than about 10 cm.',
      'note', 4600
    );
  }

  /* ─────────────────────────── OCR ─────────────────────────── */

  function warmUpOcr() {
    if (!ocrWorkerPromise) getOcrWorker().catch(() => { /* surfaced on first scan */ });
  }

  function getOcrWorker() {
    if (ocrWorkerPromise) return ocrWorkerPromise;
    ocrWorkerPromise = (async () => {
      const worker = await Tesseract.createWorker('eng');
      await worker.setParameters({ preserve_interword_spaces: '1' });
      return worker;
    })();
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
    return ocrWorkerPromise;
  }

  // 6 = one uniform block (the cropped reticle), 11 = sparse text (a whole UI screen).
  let currentPsm = null;
  async function recognize(worker, canvas, psm) {
    if (psm !== currentPsm) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      currentPsm = psm;
    }
    const { data } = await worker.recognize(canvas);
    return data && data.text;
  }

  /** The video is object-fit: cover, so the frame is scaled up and cropped by
      the edges of the element. This is the mapping back the other way. */
  function coverFit() {
    const vw = el.video.videoWidth;
    const vh = el.video.videoHeight;
    const view = el.video.getBoundingClientRect();
    if (!vw || !vh || !view.width || !view.height) return null;

    const scale = Math.max(view.width / vw, view.height / vh);
    return {
      vw, vh, view, scale,
      offsetX: (view.width - vw * scale) / 2,
      offsetY: (view.height - vh * scale) / 2,
    };
  }

  /** A viewport point as normalised frame coordinates, or null if it lands
      outside the frame altogether — the camera has no such point to focus on. */
  function framePoint(clientX, clientY) {
    const fit = coverFit();
    if (!fit) return null;

    const x = (clientX - fit.view.left - fit.offsetX) / fit.scale / fit.vw;
    const y = (clientY - fit.view.top - fit.offsetY) / fit.scale / fit.vh;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  /** Map the on-screen reticle back onto the raw video frame. */
  function reticleInFrame() {
    const fit = coverFit();
    if (!fit) return null;
    const { vw, vh, view, scale, offsetX, offsetY } = fit;
    const box = el.reticleBox.getBoundingClientRect();

    const pad = 0.08; // a little slack so a near miss still lands inside
    let sx = (box.left - view.left - offsetX) / scale - box.width * pad / scale;
    let sy = (box.top - view.top - offsetY) / scale - box.height * pad / scale;
    let sw = (box.width * (1 + 2 * pad)) / scale;
    let sh = (box.height * (1 + 2 * pad)) / scale;

    sx = Math.max(0, Math.min(sx, vw - 1));
    sy = Math.max(0, Math.min(sy, vh - 1));
    sw = Math.max(1, Math.min(sw, vw - sx));
    sh = Math.max(1, Math.min(sh, vh - sy));
    return { sx, sy, sw, sh, vw, vh };
  }

  /**
   * Copy part of the current frame into a canvas, rotated and upscaled for OCR,
   * then stretch the contrast (phone screens photograph flat and glary).
   */
  function grabFrame(region, rotation) {
    const swapped = rotation === 90 || rotation === 270;
    const srcW = region.sw;
    const srcH = region.sh;
    const outLongEdge = swapped ? srcH : srcW;
    const zoom = Math.min(3, Math.max(1, 1500 / outLongEdge));

    const w = Math.round((swapped ? srcH : srcW) * zoom);
    const h = Math.round((swapped ? srcW : srcH) * zoom);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext('2d', { willReadFrequently: true });

    c.save();
    c.translate(w / 2, h / 2);
    c.rotate((rotation * Math.PI) / 180);
    c.drawImage(
      el.video,
      region.sx, region.sy, srcW, srcH,
      (-srcW * zoom) / 2, (-srcH * zoom) / 2, srcW * zoom, srcH * zoom
    );
    c.restore();

    stretchContrast(c, w, h);
    return canvas;
  }

  function stretchContrast(c, w, h) {
    const img = c.getImageData(0, 0, w, h);
    const px = img.data;
    const hist = new Uint32Array(256);

    for (let i = 0; i < px.length; i += 4) {
      const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
      px[i] = px[i + 1] = px[i + 2] = v;
      hist[v]++;
    }

    const total = w * h;
    const cut = total * 0.02;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
    // Almost flat: keep the greyscale pass but skip the stretch, which would only amplify noise.
    if (hi - lo >= 24) {
      const span = 255 / (hi - lo);
      for (let i = 0; i < px.length; i += 4) {
        let v = (px[i] - lo) * span;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        px[i] = px[i + 1] = px[i + 2] = v;
      }
    }
    c.putImageData(img, 0, 0);
  }

  /* ──────────────────── digits out of OCR text ──────────────────── */

  // Characters Tesseract commonly returns in place of a digit.
  const LOOKALIKE = {
    O: '0', o: '0', Q: '0', D: '0',
    I: '1', l: '1', i: '1', '|': '1', '!': '1', L: '1',
    Z: '2', z: '2',
    S: '5', s: '5',
    b: '6', G: '6',
    T: '7',
    B: '8',
    g: '9', q: '9',
  };
  const DIGITISH = '0-9OoQDIiLl|!ZzSsbGTBgq';
  const RUN = new RegExp('[' + DIGITISH + '](?:[ .\\-]?[' + DIGITISH + ']){3,19}', 'g');

  function toDigits(s) {
    let out = '';
    for (const ch of s) {
      if (ch >= '0' && ch <= '9') out += ch;
      else if (LOOKALIKE[ch]) out += LOOKALIKE[ch];
    }
    return out;
  }

  /** OCR hands back the words around a code as well ("BANANAS 4011 lb"), and
      several of those letters are in the lookalike table. Letters standing off
      on their own past a space are neighbours rather than misread digits, so
      drop them; ones touching the digits are left for digitRatio to judge. */
  function trimEdges(raw) {
    return raw.replace(/^[^0-9]*[ .\-]/, '').replace(/[ .\-][^0-9]*$/, '');
  }

  /** How much of a candidate was already a real digit — keeps words like "SILO" out. */
  function digitRatio(raw) {
    const real = (raw.match(/[0-9]/g) || []).length;
    const converted = toDigits(raw).length;
    return converted ? real / converted : 0;
  }

  /* Which number wins when a frame holds several. Produce PLUs are 4 or 5
     digits (4011 bananas, 94011 the organic one) and packaged goods carry a
     full UPC or EAN; the lengths in between are nearly always a price, a date
     or a weight, so they only win when nothing better is on screen. */
  function codeScore(digits) {
    const n = digits.length;
    if (n === 12 || n === 13) return 3;   // UPC-A, EAN-13
    if (n === 4 || n === 5) return 2;     // PLU
    if (n === 8 || n === 11) return 1;    // EAN-8, or a UPC printed without its check digit
    return 0;
  }

  function beats(candidate, incumbent) {
    if (!incumbent) return true;
    const a = codeScore(candidate);
    const b = codeScore(incumbent);
    return a === b ? candidate.length > incumbent.length : a > b;
  }

  function extractCode(text) {
    if (!text) return null;
    const cleaned = text.replace(/[‐-―−]/g, '-');

    // First choice: digits sitting right after a "UPC" label (allowing OCR slop in the label).
    const labelled = cleaned.match(
      new RegExp('U\\s*[PR]\\s*[CG60]\\s*[:#\\-]?\\s*([' + DIGITISH + '](?:[ .\\-]?[' + DIGITISH + ']){3,19})', 'i')
    );
    if (labelled) {
      const raw = trimEdges(labelled[1]);
      const d = toDigits(raw);
      if (d.length >= 4 && d.length <= 14 && digitRatio(raw) >= 0.5) return d;
    }

    // Otherwise: the most code-shaped number anywhere on screen.
    let best = null;
    for (const line of cleaned.split(/\r?\n/)) {
      for (const match of (line.match(RUN) || []).map(trimEdges)) {
        const d = toDigits(match);
        if (d.length < 4 || d.length > 14) continue;
        if (digitRatio(match) < 0.7) continue;
        // A short code only counts if it was printed as one solid number,
        // otherwise every "$4.99" and "12 34" on the shelf reads as a PLU.
        if (d.length < 8 && /[ .\-]/.test(match)) continue;
        if (beats(d, best)) best = d;
      }
    }
    return best;
  }

  /* ─────────────────────────── scanning ─────────────────────────── */

  async function scan() {
    if (busy) return;
    if (!el.video.videoWidth) return setStatus('Camera is still warming up…', 'error', 1800);

    busy = true;
    el.scanBtn.disabled = true;
    setStatus('Loading text reader…');

    try {
      const region = reticleInFrame();
      if (!region) throw new Error('no frame');

      // Re-focus on the reticle before reading it — but a recent tap wins, so we
      // don't drag focus off a spot the user just picked. The OCR worker loads
      // while AF settles, so this usually costs nothing.
      const focusing = Date.now() < pinnedUntil ? null : focusAt(regionCentre(region));
      const worker = await getOcrWorker();
      if (focusing && await focusing) await settle();

      const full = { sx: 0, sy: 0, sw: region.vw, sh: region.vh, vw: region.vw, vh: region.vh };
      const passes = [
        { region, rotation: 0, psm: '6', label: 'Reading…' },
        { region, rotation: 90, psm: '6', label: 'Reading sideways…' },
        { region, rotation: 270, psm: '6', label: 'Reading sideways…' },
        { region: full, rotation: 0, psm: '11', label: 'Reading whole frame…' },
      ];

      for (const pass of passes) {
        setStatus(pass.label);
        const canvas = grabFrame(pass.region, pass.rotation);
        const code = extractCode(await recognize(worker, canvas, pass.psm));
        if (code) {
          hideStatus();
          showResult(code);
          return;
        }
      }
      setStatus('No number found — hold steady, fill the box, avoid glare.', 'error', 3200);
    } catch (err) {
      console.error(err);
      setStatus('Text reader failed to load. Check your connection.', 'error', 3600);
    } finally {
      busy = false;
      el.scanBtn.disabled = false;
    }
  }

  let statusTimer = null;
  /** tone: omitted for work in progress (shows the spinner), 'error' or 'note'. */
  function setStatus(text, tone, autoHideMs) {
    clearTimeout(statusTimer);
    el.statusText.textContent = text;
    el.status.classList.toggle('is-error', tone === 'error');
    el.status.classList.toggle('is-note', tone === 'note');
    el.status.hidden = false;
    if (autoHideMs) statusTimer = setTimeout(hideStatus, autoHideMs);
  }
  function hideStatus() {
    clearTimeout(statusTimer);
    el.status.hidden = true;
    el.status.classList.remove('is-error', 'is-note');
  }

  /* ─────────────────────────── barcode ─────────────────────────── */

  const FORMAT_NAMES = { CODE128: 'Code 128', UPC: 'UPC-A', EAN13: 'EAN-13', EAN8: 'EAN-8', ITF: 'ITF' };

  function pickFormat(digits) {
    const chosen = el.format.value;
    if (chosen !== 'auto') return chosen;
    if (digits.length <= 12) return 'UPC';   // short codes get padded out below
    if (digits.length === 13) return 'EAN13';
    return 'CODE128';
  }

  /** Standard mod-10 check digit (UPC-A, EAN-8/13): weights alternate 3,1 from the right. */
  function checkDigit(body) {
    let sum = 0;
    for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
    return (10 - (sum % 10)) % 10;
  }

  /* The scanners these codes get shown to only read UPC-A, so a short number —
     a 4- or 5-digit produce PLU, an in-store code — has to travel inside one:
     right-align it in the 11-digit body, zero-fill the front, append the check
     digit. 4011 becomes 000000040112, the same twelve digits a till looks up
     when a cashier keys the PLU in by hand. A number that is already 12 digits
     is passed through untouched so a real UPC still scans as itself. */
  function toUpcA(digits) {
    if (digits.length > 12) return null;
    if (digits.length === 12) return digits;
    const body = digits.padStart(11, '0');
    return body + checkDigit(body);
  }

  function checkDigitHint(digits, format) {
    const bodyLen = { UPC: 11, EAN13: 12, EAN8: 7 }[format];
    if (!bodyLen || digits.length !== bodyLen + 1) return '';
    const want = checkDigit(digits.slice(0, bodyLen));
    return Number(digits[bodyLen]) === want ? '' : ' The last digit should be ' + want + '.';
  }

  function renderBarcode() {
    const digits = el.digits.value.replace(/\D/g, '');
    el.barcode.innerHTML = '';
    el.barcodeValue.hidden = true;
    el.barcodeError.hidden = true;
    el.formatUsed.textContent = '';

    if (!digits) return fail('Enter some digits to build a barcode.');

    const format = pickFormat(digits);
    const value = format === 'UPC' ? toUpcA(digits) : digits;
    el.formatUsed.textContent = FORMAT_NAMES[format];

    if (!value) {
      return fail(
        digits.length + ' digits is more than UPC-A can carry — it tops out at 12. ' +
        'Shorten the number, or pick another symbology.'
      );
    }

    let ok = true;
    try {
      JsBarcode(el.barcode, value, {
        format,
        width: value.length > 16 ? 2 : 3,
        height: 130,
        margin: 12,
        displayValue: false,     // the line under the card carries the digits instead
        background: '#ffffff',
        lineColor: '#000000',
        valid: (v) => { ok = v; },
      });
    } catch (_) {
      ok = false;
    }

    if (!ok) {
      el.barcode.innerHTML = '';
      const hint = checkDigitHint(value, format);
      return fail(
        value.length + ' digits is not a valid ' + FORMAT_NAMES[format] + ' code.' +
        (hint || ' Check the digits, or pick another symbology.')
      );
    }

    // What the scanner will actually read, which for a padded PLU is not the
    // same number as the one typed above.
    el.barcodeValue.textContent = value;
    el.barcodeValue.hidden = false;
  }

  function fail(message) {
    el.barcodeError.textContent = message;
    el.barcodeError.hidden = false;
  }

  /* ─────────────────────────── views ─────────────────────────── */

  function showResult(digits) {
    el.digits.value = digits;
    renderBarcode();
    el.cameraView.classList.remove('is-active');
    el.resultView.classList.add('is-active');
    el.resultView.scrollTop = 0;
  }

  function showCamera() {
    el.digits.blur();
    el.resultView.classList.remove('is-active');
    el.cameraView.classList.add('is-active');
    hideStatus();
    if (!stream) startCamera();
  }

  /* ─────────────────────────── wiring ─────────────────────────── */

  el.scanBtn.addEventListener('click', scan);
  el.themeBtn.addEventListener('click', toggleTheme);

  // On the view rather than the video: the reticle sits on top, and this way the
  // camera bar's own buttons are the only thing we have to filter out.
  el.cameraView.addEventListener('pointerdown', handleFocusTap);

  el.manualBtn.addEventListener('click', () => {
    showResult('');
    el.digits.focus();
  });

  el.flipBtn.addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    startCamera();
  });

  el.clearBtn.addEventListener('click', () => {
    el.digits.value = '';
    el.barcode.innerHTML = '';
    el.barcodeValue.hidden = true;
    el.barcodeError.hidden = true;
    el.formatUsed.textContent = '';
    showCamera();
  });

  let renderTimer = null;
  el.digits.addEventListener('input', () => {
    const caret = el.digits.selectionStart;
    const before = el.digits.value;
    const after = before.replace(/\D/g, '');
    if (after !== before) {
      el.digits.value = after;
      const dropped = before.slice(0, caret).length - before.slice(0, caret).replace(/\D/g, '').length;
      el.digits.setSelectionRange(caret - dropped, caret - dropped);
    }
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderBarcode, 150);
  });

  el.digits.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.digits.blur(); });
  el.format.addEventListener('change', renderBarcode);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
    else if (el.cameraView.classList.contains('is-active')) startCamera();
  });

  applyTheme(currentTheme());
  startCamera();
})();
