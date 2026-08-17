# NumBar Scanner

Point your phone camera at a screen or shelf label, read the UPC digits off it, and turn
them into a scannable barcode. Everything runs in the browser — no server, no build step,
no data leaves the device.

## How it works

1. **Camera** — live preview with a reticle. Line the `UPC 4122074227` line up inside the box and tap **SCAN**.
2. **Focus** — continuous autofocus is switched on with the stream, and every scan re-focuses on the reticle
   before it reads a frame. **Tapping the preview** asks for the sharpest focus available on that spot: the
   camera's own AF goes first, and where the lens can be driven by hand the app then sweeps it and keeps
   whichever position actually looks sharpest, locking there. See [Focus support](#focus-support) — Safari
   gives web pages no focus control at all.
3. **OCR** — the frame inside the box is cropped, upscaled and contrast-stretched, then read by
   [Tesseract.js](https://tesseract.projectnaptha.com/). If the first pass finds nothing it retries
   rotated 90° and 270° (for when you're photographing a handheld device held sideways), then falls
   back to reading the whole frame.
4. **Digits** — the text is searched for a number next to a `UPC` label first, then for the longest
   plausible 8–14 digit run anywhere on screen. Common OCR slips are corrected in number context
   (`O`→`0`, `l`→`1`, `S`→`5`, `B`→`8`, …) and spaced-out digits (`4 1 2 2 0 …`) are joined.
5. **Barcode** — rendered with [JsBarcode](https://github.com/lindell/JsBarcode). The digits sit above
   the barcode in an editable field; **tap them to fix anything OCR got wrong** and the barcode
   redraws as you type. **Clear & scan again** wipes it and returns to the camera. That's all folks!

## Focus support

Focus and zoom are driven through `MediaStreamTrack.applyConstraints`, which browsers implement very unevenly:

| Browser | Continuous AF | Tap to focus | Zoom / manual focus sliders |
| --- | --- | --- | --- |
| Chrome / Edge on Android | yes | yes, on the point where the lens allows it | where the camera reports them |
| Chrome on desktop | depends on the webcam | usually a plain refocus, no point | rarely |
| Safari (iOS and macOS) | OS default only | no — the constraints don't exist | no |

Rather less declarative than that table makes it look. Three Chrome behaviours in particular will leave a
tap doing nothing at all, and the app works around each:

- **Capabilities arrive late.** `getCapabilities()` answers with a bare set — no `focusMode`, no `zoom` —
  until the camera is genuinely running. The app waits for the first frame before believing it, and never
  caches an answer that names no controls, because caching that is indistinguishable from a browser that
  has no camera controls at all. If the camera describes itself later still, the sliders appear then.
- **Zoom is behind a permission.** Chrome omits the `zoom` capability entirely unless the stream was opened
  asking for pan-tilt-zoom, so the app requests `zoom: true` up front and comes back for a plain camera if
  that ask is refused.
- **`advanced[]` constraints fail in silence.** Anything a device can't honour inside an `advanced` block is
  skipped while the promise resolves anyway, so "did it work?" always answered yes. The app sends plain
  constraints first — those reject, which is information — and keeps `advanced[]` only for engines that
  won't take these keys outside it. `applyConstraints` also *replaces* a track's constraints rather than
  merging into them, so every call re-sends the whole set; otherwise a focus tap would drop your zoom.

`pointsOfInterest` is never reported by `getCapabilities()`, so the app sends the tapped point and reads the
track back to see whether it stuck. Where it didn't, the lens is walked out of continuous AF and back, since
a camera already in continuous mode treats "be continuous" as a no-op and never looks again. Where there's
no focus control whatsoever, the first tap says so once rather than showing a focus ring that does nothing.

### Measured focus

Even a tap that lands correctly often leaves the label soft: the lens is centimetres from a flat, low-contrast
barcode, and the phone's AF is weighing the whole scene when it decides what the subject is. So where the
device exposes `focusDistance`, a tap doesn't stop at asking. The app measures gradient energy over the middle
of the reticle at native resolution, walks the lens across its range (following the focus slider's own curve,
which spends most of its travel down at the near end), closes in on the winner with two halving rounds, and
locks there. Roughly fifteen readings, about two seconds, with `Finding focus…` on screen throughout.

Two things keep that honest. The comparison is always relative — absolute sharpness depends on the label, the
print and the light, so no fixed threshold would survive a real shelf — and the camera's own attempt is
measured first and stays in the running. A sweep has to beat AF by 10% to be believed; if it can't, the lens
goes straight back to autofocus. When the winning position is hard against the near stop, the label is closer
than the glass can resolve and the app says so instead of pretending otherwise.

The result lands in the focus slider, so you can nudge it by hand from there, and **Auto** hands the lens back
to continuous AF.

None of this beats physics: most phone main cameras can't focus nearer than roughly 10 cm. If a label won't
come sharp, back off and let the reticle crop do the work — the frame inside the box is upscaled before OCR
anyway, so a smaller, sharp number reads better than a large, blurry one. The zoom slider is the honest way
round the near limit: it fills the box from a distance the lens can actually focus at.

## Symbology

The **Auto** setting picks by digit count:

| Digits | Format |
| --- | --- |
| 8 | EAN-8 |
| 11 or 12 | UPC-A (the check digit is computed for you at 11) |
| 13 | EAN-13 |
| anything else | Code 128 |

The 10-digit codes these retail apps show aren't a valid UPC-A, so they come out as **Code 128** —
which encodes any number and scans on essentially every retail scanner. If your scanner expects
something else, override it with the **Symbology** dropdown (Interleaved 2 of 5 is the other common
choice for 10-digit codes). If you force a fixed-length format and the digits don't fit, the app
says so — and tells you the correct check digit when that's the problem.

## Running it

It's a static site. Open `index.html` over **https** or `localhost` — browsers block camera access
on plain `http`, and `file://` counts as insecure in some browsers.

```bash
python -m http.server 8000     # then visit http://localhost:8000
```

To reach it from your phone on the same Wi-Fi you'll need https, so it's easiest to just test on
the deployed GitHub Pages URL.

## Deploying to GitHub Pages

Push this repo, then in **Settings → Pages** set *Source* to **Deploy from a branch**, branch
`main`, folder `/ (root)`. The site appears at `https://<user>.github.io/<repo>/` within a minute or
two. Pages serves over https, so the camera works.

## Files

- [index.html](index.html) — markup for the two views (camera, result)
- [app.css](app.css) — styling, mobile-first, dark
- [app.js](app.js) — camera, focus, image preprocessing, OCR, digit extraction, barcode rendering

The two dependencies load from jsDelivr; the OCR language data (~15 MB, cached after first use)
comes from the Tesseract.js CDN, so the first scan on a fresh device needs a connection.
