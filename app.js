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
    scanBtn: $('scan-btn'),
    manualBtn: $('manual-btn'),
    flipBtn: $('flip-btn'),
    clearBtn: $('clear-btn'),
    status: $('status'),
    statusText: $('status-text'),
    cameraError: $('camera-error'),
    digits: $('digits'),
    barcode: $('barcode'),
    barcodeError: $('barcode-error'),
    format: $('format'),
    formatUsed: $('format-used'),
    themeBtn: $('theme-btn'),
    themeMeta: document.querySelector('meta[name="theme-color"]'),
  };

  let stream = null;
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
  }

  function showCameraError(message) {
    el.cameraError.textContent = message;
    el.cameraError.hidden = false;
    el.scanBtn.disabled = true;
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

  /** Map the on-screen reticle back onto the raw video frame (video uses object-fit: cover). */
  function reticleInFrame() {
    const vw = el.video.videoWidth;
    const vh = el.video.videoHeight;
    const view = el.video.getBoundingClientRect();
    const box = el.reticleBox.getBoundingClientRect();
    if (!vw || !vh || !view.width || !view.height) return null;

    const scale = Math.max(view.width / vw, view.height / vh);
    const offsetX = (view.width - vw * scale) / 2;
    const offsetY = (view.height - vh * scale) / 2;

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
  const RUN = new RegExp('[' + DIGITISH + '](?:[ .\\-]?[' + DIGITISH + ']){5,19}', 'g');

  function toDigits(s) {
    let out = '';
    for (const ch of s) {
      if (ch >= '0' && ch <= '9') out += ch;
      else if (LOOKALIKE[ch]) out += LOOKALIKE[ch];
    }
    return out;
  }

  /** How much of a candidate was already a real digit — keeps words like "SILO" out. */
  function digitRatio(raw) {
    const real = (raw.match(/[0-9]/g) || []).length;
    const converted = toDigits(raw).length;
    return converted ? real / converted : 0;
  }

  function extractCode(text) {
    if (!text) return null;
    const cleaned = text.replace(/[‐-―−]/g, '-');

    // First choice: digits sitting right after a "UPC" label (allowing OCR slop in the label).
    const labelled = cleaned.match(
      new RegExp('U\\s*[PR]\\s*[CG60]\\s*[:#\\-]?\\s*([' + DIGITISH + '](?:[ .\\-]?[' + DIGITISH + ']){4,19})', 'i')
    );
    if (labelled) {
      const d = toDigits(labelled[1]);
      if (d.length >= 6 && d.length <= 14 && digitRatio(labelled[1]) >= 0.5) return d;
    }

    // Otherwise: the longest plausible number anywhere on screen.
    let best = null;
    for (const line of cleaned.split(/\r?\n/)) {
      for (const match of line.match(RUN) || []) {
        const d = toDigits(match);
        if (d.length < 8 || d.length > 14) continue;
        if (digitRatio(match) < 0.7) continue;
        if (!best || d.length > best.length) best = d;
      }
    }
    return best;
  }

  /* ─────────────────────────── scanning ─────────────────────────── */

  async function scan() {
    if (busy) return;
    if (!el.video.videoWidth) return setStatus('Camera is still warming up…', true, 1800);

    busy = true;
    el.scanBtn.disabled = true;
    setStatus('Loading text reader…');

    try {
      const worker = await getOcrWorker();
      const region = reticleInFrame();
      if (!region) throw new Error('no frame');

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
      setStatus('No number found — hold steady, fill the box, avoid glare.', true, 3200);
    } catch (err) {
      console.error(err);
      setStatus('Text reader failed to load. Check your connection.', true, 3600);
    } finally {
      busy = false;
      el.scanBtn.disabled = false;
    }
  }

  let statusTimer = null;
  function setStatus(text, isError, autoHideMs) {
    clearTimeout(statusTimer);
    el.statusText.textContent = text;
    el.status.classList.toggle('is-error', !!isError);
    el.status.hidden = false;
    if (autoHideMs) statusTimer = setTimeout(hideStatus, autoHideMs);
  }
  function hideStatus() {
    clearTimeout(statusTimer);
    el.status.hidden = true;
    el.status.classList.remove('is-error');
  }

  /* ─────────────────────────── barcode ─────────────────────────── */

  const FORMAT_NAMES = { CODE128: 'Code 128', UPC: 'UPC-A', EAN13: 'EAN-13', EAN8: 'EAN-8', ITF: 'ITF' };

  function pickFormat(digits) {
    const chosen = el.format.value;
    if (chosen !== 'auto') return chosen;
    if (digits.length === 11 || digits.length === 12) return 'UPC';
    if (digits.length === 13) return 'EAN13';
    if (digits.length === 8) return 'EAN8';
    return 'CODE128';
  }

  /** Standard mod-10 check digit (UPC-A, EAN-8/13): weights alternate 3,1 from the right. */
  function checkDigit(body) {
    let sum = 0;
    for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
    return (10 - (sum % 10)) % 10;
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
    el.barcodeError.hidden = true;

    if (!digits) {
      el.formatUsed.textContent = '';
      return fail('Enter some digits to build a barcode.');
    }

    const format = pickFormat(digits);
    el.formatUsed.textContent = FORMAT_NAMES[format] + ' · ' + digits.length + ' digits';

    let ok = true;
    try {
      JsBarcode(el.barcode, digits, {
        format,
        width: digits.length > 16 ? 2 : 3,
        height: 130,
        margin: 12,
        displayValue: false,     // the editable digits above are the human-readable line
        background: '#ffffff',
        lineColor: '#000000',
        valid: (v) => { ok = v; },
      });
    } catch (_) {
      ok = false;
    }

    if (!ok) {
      el.barcode.innerHTML = '';
      return fail(
        digits.length + ' digits is not a valid ' + FORMAT_NAMES[format] + ' code.' +
        checkDigitHint(digits, format) +
        ' Switch the symbology to Code 128 to encode any number.'
      );
    }
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
