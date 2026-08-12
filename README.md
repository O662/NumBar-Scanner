# NumBar Scanner

Point your phone camera at a screen or shelf label, read the UPC digits off it, and turn
them into a scannable barcode. Everything runs in the browser — no server, no build step,
no data leaves the device.

## How it works

1. **Camera** — live preview with a reticle. Line the `UPC 4122074227` line up inside the box and tap **SCAN**.
2. **OCR** — the frame inside the box is cropped, upscaled and contrast-stretched, then read by
   [Tesseract.js](https://tesseract.projectnaptha.com/). If the first pass finds nothing it retries
   rotated 90° and 270° (for when you're photographing a handheld device held sideways), then falls
   back to reading the whole frame.
3. **Digits** — the text is searched for a number next to a `UPC` label first, then for the longest
   plausible 8–14 digit run anywhere on screen. Common OCR slips are corrected in number context
   (`O`→`0`, `l`→`1`, `S`→`5`, `B`→`8`, …) and spaced-out digits (`4 1 2 2 0 …`) are joined.
4. **Barcode** — rendered with [JsBarcode](https://github.com/lindell/JsBarcode). The digits sit above
   the barcode in an editable field; **tap them to fix anything OCR got wrong** and the barcode
   redraws as you type. **Clear & scan again** wipes it and returns to the camera.

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
- [app.js](app.js) — camera, image preprocessing, OCR, digit extraction, barcode rendering

The two dependencies load from jsDelivr; the OCR language data (~15 MB, cached after first use)
comes from the Tesseract.js CDN, so the first scan on a fresh device needs a connection.
