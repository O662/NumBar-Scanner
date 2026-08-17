/* NumBar Scanner, point the camera at a screen or label, read the UPC digits,
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
    camControls: $('cam-controls'),
    zoomRow: $('zoom-row'),
    zoomRange: $('zoom-range'),
    zoomValue: $('zoom-value'),
    focusRow: $('focus-row'),
    focusRange: $('focus-range'),
    focusAutoBtn: $('focus-auto'),
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

    const want = {
      facingMode: { ideal: facingMode },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    };

    /* `zoom: true` is the pan-tilt-zoom opt-in. Chrome refuses to admit a
       camera has zoom at all , getCapabilities().zoom simply isn't there
       unless the stream was opened asking for it, which is why the zoom
       slider never appeared on Android. Browsers that don't know the key
       discard it. Asking does mean a slightly different permission prompt, so
       if the ask itself is what fails we come back for a plain camera rather
       than losing the picture over a nicety. */
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: Object.assign({ zoom: true }, want),
        audio: false,
      });
    } catch (_) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false });
      } catch (err) {
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        return showCameraError(
          denied
            ? 'Camera permission was blocked. Allow camera access for this site in your browser settings, then reload.'
            : 'Could not open the camera (' + (err && err.name ? err.name : 'unknown error') + '). Use “Type it in” instead.'
        );
      }
    }

    el.cameraError.hidden = true;
    el.video.srcObject = stream;
    try { await el.video.play(); } catch (_) { /* autoplay attrs usually cover this */ }

    videoTrack = stream.getVideoTracks()[0] || null;
    const opened = videoTrack;

    warmUpOcr();

    // Only offer the flip button when there is something to flip to.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      el.flipBtn.hidden = devices.filter((d) => d.kind === 'videoinput').length < 2;
    } catch (_) { /* ignore */ }

    // Everything below is built out of the track's capabilities, and those
    // aren't trustworthy until the camera is genuinely running, see caps().
    await trackReady();
    if (videoTrack !== opened) return;   // flipped or stopped while we waited
    await enableContinuousFocus();
    setupCameraControls();
  }

  /** Resolve once the camera is pushing frames and has owned up to what it can
      do. Bounded at both ends: a camera that never answers must not leave the
      viewfinder without controls forever. */
  async function trackReady() {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      setTimeout(finish, 1500);
      if (el.video.requestVideoFrameCallback) el.video.requestVideoFrameCallback(finish);
      else if (el.video.readyState >= 2) finish();
      else el.video.addEventListener('loadeddata', finish, { once: true });
    });
    for (let i = 0; i < 10 && !controlsKnown(); i++) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  function controlsKnown() {
    const c = caps();
    return !!(c.focusMode || c.zoom || c.focusDistance);
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    // The next camera may be a different lens with different focus capabilities.
    videoTrack = null;
    trackCaps = null;
    applied = {};
    manualFocus = false;
    pinnedUntil = 0;
    focusHintShown = false;
    clearTimeout(refocusTimer);
    el.camControls.hidden = true;
  }

  function showCameraError(message) {
    el.cameraError.textContent = message;
    el.cameraError.hidden = false;
    el.scanBtn.disabled = true;
  }

  /* ─────────────────────── focus and zoom ───────────────────────
     A UPC line has to sit close to fill the reticle, and that is exactly where
     phone cameras hunt: continuous AF keeps drifting onto whatever is behind
     the label. So we hold continuous AF as the resting state, let a tap pin the
     focus to one spot for a few seconds, and re-focus on the reticle just
     before a scan.

     When AF still won't settle there are two manual escapes, each offered only
     where the device reports it. The focus slider drives the lens directly
     (focusMode: 'manual') and simply stays where it's put. The zoom slider is
     the one that beats physics: zooming in fills the reticle from a distance
     the camera can actually focus at, rather than pushing inside its ~10 cm
     near limit where nothing will ever be sharp. Where the browser exposes no
     focus control at all (Safari ships none of these constraints) every call
     below no-ops, both sliders stay hidden, and the tap handler says so once
     instead of pretending.

     None of this is as declarative as it looks. Chrome answers getCapabilities()
     with a bare set until the camera is actually running, hides zoom entirely
     unless the stream was opened asking for pan-tilt-zoom, silently discards
     anything in an advanced[] block it can't honour while resolving the promise
     anyway, and replaces a track's whole constraint set on every applyConstraints
     call rather than merging. So: wait for the camera before believing it, ask
     for PTZ up front, prefer plain constraints because those actually reject,
     confirm against getSettings(), and re-send the whole set every time. */

  const REFOCUS_MS = 3000;    // how long a tapped focus point stays pinned
  const AF_SETTLE_MS = 450;   // single-shot AF reports "applied", not "converged"
  const FOCUS_STEPS = 1000;   // focus slider resolution, mapped onto the lens range below

  const POI_TOLERANCE = 0.12;  // how close a read-back focus point has to land

  let trackCaps = null;
  let refocusTimer = null;
  let pinnedUntil = 0;
  let manualFocus = false;
  let focusHintShown = false;

  /** Chrome fills a track's capabilities in asynchronously: for the first
      moment after getUserMedia resolves it answers with a bare set that names
      no focus control, and only later admits to focusMode and the rest. We
      used to read that once and cache it, which is indistinguishable from a
      browser that has no camera controls at all , every tap then took the
      "this browser won't let the page drive focus" path and both sliders
      stayed hidden for the life of the stream. So only an answer that names a
      control we can actually use is worth keeping; anything else we ask again. */
  function caps() {
    if (!videoTrack || !videoTrack.getCapabilities) return {};
    if (trackCaps) return trackCaps;
    let now = {};
    try { now = videoTrack.getCapabilities() || {}; } catch (_) { now = {}; }
    if (now.focusMode || now.zoom || now.focusDistance) {
      trackCaps = now;
      // Startup only waits so long, so a camera slower than that had its
      // sliders hidden on the strength of an answer it hadn't finished giving.
      // This is the moment it finally said something: build them now. Not
      // re-entrant , trackCaps is set, so the call below won't come back here.
      setTimeout(setupCameraControls, 0);
    }
    return now;
  }

  function trackSettings() {
    if (!videoTrack || !videoTrack.getSettings) return {};
    try { return videoTrack.getSettings() || {}; } catch (_) { return {}; }
  }

  function focusModes() {
    return caps().focusMode || [];
  }

  function canFocus() {
    const modes = focusModes();
    return modes.includes('single-shot') || modes.includes('continuous');
  }

  /** A capability range is only worth a slider if it actually spans something. */
  function usableRange(range) {
    return range && typeof range.min === 'number' && range.max > range.min ? range : null;
  }

  function canManualFocus() {
    return focusModes().includes('manual') && !!usableRange(caps().focusDistance);
  }

  function canZoom() {
    return !!usableRange(caps().zoom);
  }

  /* applyConstraints replaces a track's whole constraint set rather than
     merging into it, so sending a bare {focusMode} would quietly drop the zoom
     the user just dialled in. Everything we ask the camera for therefore lives
     in one object that gets re-sent in full on every change. A null in
     `changes` means "stop asking for this". */
  let applied = {};

  async function applyCamera(changes) {
    if (!videoTrack) return false;

    const next = Object.assign({}, applied, changes);
    Object.keys(next).forEach((k) => { if (next[k] === null) delete next[k]; });

    /* Plainly first, advanced[] second, and that order is the whole point:
       anything inside advanced[] that a device can't honour is skipped in
       silence and the promise still resolves, so the old code's "did it
       work?" answer was always yes and its fallback path was dead. A plain
       constraint set rejects instead, which is information , we only reach
       for advanced[] for engines that won't take these keys outside it. */
    if (!await sendConstraints(next) && !await sendConstraints({ advanced: [next] })) return false;
    applied = next;
    return true;
  }

  async function sendConstraints(constraints) {
    try {
      await videoTrack.applyConstraints(constraints);
      return true;
    } catch (_) {
      return false;
    }
  }

  /* Leaving manual behind means dropping the focusDistance with it. A lens
     handed "continuous, and also sit at 8 cm" honours whichever half it feels
     like, and a slider the user has since walked away from is not a request. */
  const AUTO = { focusDistance: null, pointsOfInterest: null };

  async function enableContinuousFocus() {
    setManualFocus(false);
    if (!focusModes().includes('continuous')) return false;
    return applyCamera(Object.assign({ focusMode: 'continuous' }, AUTO));
  }

  /** Did the camera actually take the focus point we handed it? */
  function aimedAt(point) {
    const poi = trackSettings().pointsOfInterest;
    if (!poi || !poi.length) return false;
    const got = poi[0];
    return Math.abs(got.x - point.x) < POI_TOLERANCE
      && Math.abs(got.y - point.y) < POI_TOLERANCE;
  }

  /** A camera already in continuous AF ignores being told to enter continuous
      AF: the resting state is also the request, so nothing happens and the
      lens goes on staring at the background. Take it away for a beat and hand
      it back , the mode change is what restarts the hunt. Any focus point in
      play is deliberately left in the set: a device that took it should keep
      it, and this is exactly the case where we can't tell whether it did. */
  async function nudgeFocus() {
    if (!focusModes().includes('manual')) return false;
    const f = usableRange(caps().focusDistance);
    const near = f ? f.min + (f.max - f.min) * 0.02 : null;
    const parked = await applyCamera(near === null
      ? { focusMode: 'manual' }
      : { focusMode: 'manual', focusDistance: near });
    if (!parked) return false;
    await new Promise((r) => setTimeout(r, 80));
    const back = await applyCamera({ focusMode: 'continuous', focusDistance: null });
    // A hunt started from the wrong end of the lens takes longer than the
    // settle a caller allows for one already in progress, so hold here for the
    // difference rather than photographing the sweep.
    if (back) await new Promise((r) => setTimeout(r, 250));
    return back;
  }

  /** Aim AF at one spot in the frame, given as normalised 0–1 coordinates. */
  async function focusAt(point) {
    if (!canFocus()) return false;
    const single = focusModes().includes('single-shot');
    const mode = single ? 'single-shot' : 'continuous';

    setManualFocus(false);
    clearTimeout(refocusTimer);

    // pointsOfInterest is never advertised in getCapabilities(), so the only
    // way to find out whether a device takes one is to send it. A rejection
    // means no; silence means maybe , Chrome will accept the focusMode half of
    // this and drop the point on the floor without saying anything.
    const aimed = await applyCamera({
      focusMode: mode, focusDistance: null, pointsOfInterest: [point],
    });
    if (!aimed) {
      // Wouldn't take a point at all. The mode on its own is still worth
      // asking for: the hunt then happens wherever the camera prefers to look,
      // which beats a lens parked on whatever is behind the label.
      const plain = await applyCamera({
        focusMode: mode, focusDistance: null, pointsOfInterest: null,
      });
      if (!plain) return false;
    }

    /* single-shot re-runs its hunt on every apply, so it has already gone.
       Continuous has not: it was continuous before the tap and it is
       continuous now. Where the track won't confirm the point , either it
       ignored it or it just doesn't report it , that shove is the only thing
       standing between a tap and nothing happening at all. */
    if (!single && !aimedAt(point)) await nudgeFocus();

    // single-shot leaves focus locked, so hand it back to continuous after a beat.
    if (single) refocusTimer = setTimeout(enableContinuousFocus, REFOCUS_MS);
    return true;
  }

  /* ───────────── measured focus (contrast detection) ─────────────
     Asking the camera to focus and hoping is what every tap did until now, and
     on a barcode held close it loses often: the lens is a few centimetres from
     a flat, low-contrast label, and the phone's own AF is weighing the whole
     scene when it decides what the subject is. Where the lens can be driven by
     hand there is a better answer — drive it ourselves, look at what comes
     back, and keep whatever is sharpest. That is what any AF does internally.
     The difference is that ours is looking at the reticle and nothing else.

     Everything here is relative. Absolute sharpness depends on the label, the
     print and the light, so no fixed threshold would survive contact with a
     real shelf; the only comparison worth anything is between two readings of
     the same scene moments apart. The camera's own attempt is measured first
     and stays in the running, so a sweep can only ever improve on it — if it
     can't, the lens goes straight back to AF. */

  const SWEEP_STEPS = 9;      // rungs of the coarse pass across the focus range
  const SWEEP_REFINES = 2;    // halving rounds closing in on the coarse winner
  const LENS_MS = 80;         // lens travel to allow before a reading counts
  const SHARP_PATCH = 320;    // px of reticle centre sampled, at 1:1
  const SWEEP_MARGIN = 1.10;  // how much a sweep must beat AF by to be believed

  let sharpCanvas = null;
  let focusJob = 0;           // bumped per tap; an older sweep sees it and stops
  let focusWork = null;       // in flight, so a scan can wait rather than race

  function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** Resolve on the next painted frame, so a reading is never taken of the
      picture that was already on screen before the lens moved. */
  function nextFrame() {
    return new Promise((resolve) => {
      if (!el.video.requestVideoFrameCallback) return setTimeout(resolve, 60);
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      el.video.requestVideoFrameCallback(fin);
      setTimeout(fin, 90);
    });
  }

  /** Gradient energy across the middle of the reticle, sampled at native
      resolution — scaling the crop down first would low-pass away the very
      detail that separates a sharp frame from a soft one. Green stands in for
      luma: it carries most of the detail and costs nothing to read. */
  function sharpness() {
    const r = reticleInFrame();
    if (!r || !el.video.videoWidth) return 0;

    const w = Math.max(8, Math.min(SHARP_PATCH, Math.round(r.sw)));
    const h = Math.max(8, Math.min(SHARP_PATCH, Math.round(r.sh)));
    const sx = r.sx + (r.sw - w) / 2;
    const sy = r.sy + (r.sh - h) / 2;

    if (!sharpCanvas) sharpCanvas = document.createElement('canvas');
    sharpCanvas.width = w;
    sharpCanvas.height = h;
    const c = sharpCanvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(el.video, sx, sy, w, h, 0, 0, w, h);

    let d;
    try { d = c.getImageData(0, 0, w, h).data; } catch (_) { return 0; }

    const stride = w * 4;
    let sum = 0;
    let n = 0;
    for (let y = 2; y < h - 2; y += 2) {
      for (let x = 2; x < w - 2; x += 2) {
        const i = y * stride + x * 4 + 1;
        const gx = d[i + 8] - d[i - 8];                 // two pixels either side
        const gy = d[i + stride * 2] - d[i - stride * 2];
        sum += gx * gx + gy * gy;
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  /** Park the lens at one point on the focus slider's curve and read back what
      the reticle looks like from there. */
  async function probe(pos, token) {
    const distance = sliderToDistance(pos);
    const set = await applyCamera({
      focusMode: 'manual', focusDistance: distance, pointsOfInterest: null,
    });
    if (!set || token !== focusJob) return null;
    // Lens travel, then two frames: the first one out of the camera can still
    // be mid-move or mid-exposure, and one bad reading is enough to put the
    // peak in the wrong place for the whole sweep.
    await pause(LENS_MS);
    await nextFrame();
    await nextFrame();
    if (token !== focusJob) return null;
    return { pos, distance, score: sharpness() };
  }

  /** Walk the focus range and return the sharpest place on it. The walk
      follows the slider's own curve rather than the raw metres, which spends
      most of its rungs down at the near end where a held-up label actually is. */
  async function sweepFocus(token) {
    let best = null;
    for (let i = 0; i <= SWEEP_STEPS; i++) {
      const shot = await probe((i / SWEEP_STEPS) * FOCUS_STEPS, token);
      if (!shot) return null;
      if (!best || shot.score > best.score) best = shot;
    }
    if (!best) return null;

    /* The coarse grid is deliberately coarse and the real peak sits between
       two of its rungs, so close in on it: each round tries half a gap either
       side of the current winner and halves again. This is where the accuracy
       actually comes from — at 12 cm the depth of field is thin enough that
       landing one coarse rung away is still visibly soft. */
    let span = FOCUS_STEPS / SWEEP_STEPS / 2;
    for (let round = 0; round < SWEEP_REFINES; round++) {
      for (const pos of [best.pos - span, best.pos + span]) {
        if (pos < 0 || pos > FOCUS_STEPS) continue;
        const shot = await probe(pos, token);
        if (token !== focusJob) return null;
        if (shot && shot.score > best.score) best = shot;
      }
      span /= 2;
    }
    return best;
  }

  /** What a tap means now: aim the camera's own AF at the spot, then check its
      work and beat it where we can. */
  async function sharpenAt(point) {
    const token = ++focusJob;
    const drove = await focusAt(point);
    if (token !== focusJob) return;

    if (!canManualFocus()) {
      if (!drove) focusUnsupportedHint();   // native AF was the whole toolbox
      return;
    }

    // Let AF finish before judging it. A reading taken mid-hunt is a reading
    // of a lens in motion, which is blur by definition and not AF's fault.
    await settle();
    let native = sharpness();
    await pause(220);
    if (token !== focusJob) return;
    native = Math.max(native, sharpness());

    // From here the lens is ours: nothing gets to drag it back to continuous
    // half way through the sweep.
    clearTimeout(refocusTimer);
    setStatus('Finding focus…');

    const best = await sweepFocus(token);
    if (token !== focusJob) return;

    if (!best || best.score <= native * SWEEP_MARGIN) {
      // AF had it, or the sweep couldn't prove otherwise. Hand the lens back
      // rather than locking it somewhere no better than where it started.
      await focusAt(point);
      if (token === focusJob) hideStatus();
      return;
    }

    await applyCamera({
      focusMode: 'manual', focusDistance: best.distance, pointsOfInterest: null,
    });
    if (token !== focusJob) return;
    clearTimeout(refocusTimer);
    pinnedUntil = 0;
    setManualFocus(true);                 // the slider now holds what we found
    el.focusRange.value = distanceToSlider(best.distance);

    // Hard against the near stop means the label is closer than this lens can
    // resolve, and no amount of driving it will change that.
    setStatus(best.pos >= FOCUS_STEPS * 0.97
      ? 'Focused as near as this lens goes — if it’s still soft, back off and zoom in.'
      : 'Focus locked on the box.', 'note', 2400);
  }

  /* ───────────────── the manual sliders ───────────────── */

  /* focusDistance is reported in metres, so the near end of the range , the
     only part that matters for a label held under the lens , is a thin slice at
     the bottom of it, which a linear slider would cross in a couple of pixels.
     Squaring the position spends most of the travel down there instead: the
     step per pixel falls to nothing as you approach the near end, which is what
     makes hand-focusing on a barcode possible at all. Right-hand end is near. */
  function sliderToDistance(pos) {
    const f = caps().focusDistance;
    const t = 1 - pos / FOCUS_STEPS;
    return f.min + (f.max - f.min) * t * t;
  }

  function distanceToSlider(distance) {
    const f = caps().focusDistance;
    const norm = Math.min(1, Math.max(0, (distance - f.min) / (f.max - f.min)));
    return Math.round((1 - Math.sqrt(norm)) * FOCUS_STEPS);
  }

  /** applyConstraints is async and a dragged slider fires far faster than a lens
      can answer, so only ever keep the latest value in flight. */
  function coalesced(apply) {
    let running = false;
    let queued = null;
    return (value) => {
      queued = value;
      if (running) return;
      running = true;
      (async () => {
        while (queued !== null) {
          const next = queued;
          queued = null;
          await apply(next);
        }
        running = false;
      })();
    };
  }

  const pushFocusDistance = coalesced((focusDistance) =>
    applyCamera({ focusMode: 'manual', focusDistance, pointsOfInterest: null }));

  const pushZoom = coalesced((zoom) => applyCamera({ zoom }));

  function setManualFocus(on) {
    manualFocus = on;
    el.focusRange.classList.toggle('is-idle', !on);
    el.focusAutoBtn.disabled = !on;
  }

  /** Cameras report zoom in whatever units they like , 1–8, 100–800 , so show it
      as a multiple of the wide end rather than the raw number. */
  function showZoom(value) {
    const z = caps().zoom;
    const ratio = z && z.min > 0 ? value / z.min : value;
    el.zoomValue.textContent = ratio.toFixed(1) + '×';
  }

  function setupCameraControls() {
    const now = trackSettings();

    const zoomOk = canZoom();
    if (zoomOk) {
      const z = caps().zoom;
      const value = typeof now.zoom === 'number' ? now.zoom : z.min;
      el.zoomRange.min = z.min;
      el.zoomRange.max = z.max;
      el.zoomRange.step = z.step > 0 ? z.step : (z.max - z.min) / 100;
      el.zoomRange.value = value;
      showZoom(value);
    }
    el.zoomRow.hidden = !zoomOk;

    const focusOk = canManualFocus();
    if (focusOk) {
      el.focusRange.min = 0;
      el.focusRange.max = FOCUS_STEPS;
      el.focusRange.step = 1;
      // Parked at the near end, which is the reason anyone reaches for this.
      el.focusRange.value = typeof now.focusDistance === 'number'
        ? distanceToSlider(now.focusDistance)
        : FOCUS_STEPS;
      setManualFocus(false);
    }
    el.focusRow.hidden = !focusOk;

    el.camControls.hidden = !(zoomOk || focusOk);
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
    if (!videoTrack) return;
    // Everything in the dock , shutter, sliders, the padding around them ,
    // belongs to the control it sits in, not to the viewfinder behind it.
    if (e.target.closest && e.target.closest('.camera-dock')) return;
    const point = framePoint(e.clientX, e.clientY);
    if (!point) return;
    if (!canFocus()) return focusUnsupportedHint();

    showFocusRing(e.clientX, e.clientY);
    pinnedUntil = Date.now() + REFOCUS_MS;
    // A tap is a request for the sharpest focus available on that spot, which
    // is not the same thing as a request for autofocus, and on this hardware
    // often isn't satisfied by it.
    focusWork = sharpenAt(point).finally(() => { focusWork = null; });
  }

  /** Two different disappointments, and it matters which one you're having:
      a browser that exposes no focus control, or a lens that has one but
      wouldn't take the point. Both end in "hold further back", for the same
      reason , nothing focuses inside about 10 cm. */
  function focusUnsupportedHint() {
    if (focusHintShown) return;
    focusHintShown = true;
    setStatus(
      canFocus()
        ? 'No focus point , ' +
          'go further back, or zoom in.'
        : 'Browser won’t let page drive focus. Pull back a little. ' +
          '(most phone cameras can’t focus closer than about 10 cm.)',
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
      outside the frame altogether , the camera has no such point to focus on. */
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

  /** How much of a candidate was already a real digit , keeps words like "SILO" out. */
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

      // A tap still working through its sweep is about to land on the sharpest
      // focus available; reading the frame out from under it would throw that
      // away for the sake of a second.
      if (focusWork) {
        setStatus('Finding focus…');
        await focusWork;
      }

      // Re-focus on the reticle before reading it , but a recent tap wins, and a
      // hand-set focus wins outright, so we never drag the lens off a spot the
      // user just picked. The OCR worker loads while AF settles, so this usually
      // costs nothing.
      const keepFocus = manualFocus || Date.now() < pinnedUntil;
      const focusing = keepFocus ? null : focusAt(regionCentre(region));
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
      setStatus('No number found , hold steady, fill the box, avoid glare.', 'error', 3200);
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

  /* The scanners these codes get shown to only read UPC-A, so a short number ,
     a 4- or 5-digit produce PLU, an in-store code , has to travel inside one:
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
        digits.length + ' digits is more than UPC-A can carry , it tops out at 12. ' +
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

  el.zoomRange.addEventListener('input', () => {
    const value = Number(el.zoomRange.value);
    showZoom(value);
    pushZoom(value);
  });

  el.focusRange.addEventListener('input', () => {
    setManualFocus(true);
    // Hand focus over for good: no pending re-focus timer, no tap still pinned.
    clearTimeout(refocusTimer);
    pinnedUntil = 0;
    pushFocusDistance(sliderToDistance(Number(el.focusRange.value)));
  });

  el.focusAutoBtn.addEventListener('click', enableContinuousFocus);

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
