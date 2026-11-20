# Private Passport Photo Maker

**▶ Try it: [erajkhatiwada.github.io/private-passport-photo-maker](https://erajkhatiwada.github.io/private-passport-photo-maker/)**

Make passport and visa photos in the browser, with AI doing the hard parts. **Your photo never leaves your device.**

What the AI does for you:

- **Finds your face:** locates the eyes, chin and head tilt.
- **Crops to spec:** sizes, centres and straightens the photo for the selected country's rules.
- **Replaces the background:** separates you from the background and swaps in white, light grey, light blue or any colour.
- **Checks the result:** head size, eye height, tilt, eyes open, neutral expression and more.

The AI runs entirely on your device. Google's MediaPipe models are downloaded once from this site and run inside your browser, so no photo is sent to any server.

## Privacy model

| Guarantee | How it is enforced |
|---|---|
| No upload | It's a static site. There is no backend and no upload code. |
| No connections to other servers | The page's Content-Security-Policy (`<meta>` in `index.html`) sets `connect-src 'self'` and `default-src 'none'`. The browser refuses any request to another origin. |
| No third-party scripts, fonts or CDNs | The MediaPipe runtime and models are served from this site (`vendor/`, `models/`). |
| No usage statistics | MediaPipe Tasks normally sends anonymous performance metrics to `odml.pa.googleapis.com` (not image data). The CSP blocks that request, so you'll see one *"violates the Content Security Policy"* message per model in the console. That is expected. |
| Works offline | Once "AI ready" shows, you can turn off the network and everything keeps working. |
| Nothing stored | No cookies, no storage. "Start over" or closing the tab discards the photo. |
| Clean output | Downloads are newly rendered pixels, without EXIF/GPS metadata. JPEGs carry the correct DPI so they print at true size. |

The privacy dialog in the app also shows a live count of network requests made since the photo was added. It should stay at 0.

## Features

- **Input:** choose a file, drag and drop, or take a photo with the webcam (with an optional 3-second timer).
- **AI crop:** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) finds the eyes, chin and head tilt. The person mask from the [Selfie Multiclass segmenter](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) finds the top of the head. The app then sizes and places a rotated crop box so the head height and eye line meet the selected spec, and the eyes come out level.
- **Editor:** drag to move, corners to resize, knob to rotate, wheel or pinch to zoom, arrow keys to nudge. Guides show the target head oval and the eye band.
- **Background:** keep the original, or replace it with white, off-white, light grey, light blue or any colour. Edges are refined with a colour-guided filter, and an edge slider runs from soft to tight.
- **Checks:** head size, eye height, head cut off, centring, tilt, facing the camera, eyes open, neutral expression, resolution, whether the crop goes past the photo edge, and whether the original background is plain and light.
- **Sizes:** US 2×2 in, UK 35×45, Schengen/EU/ICAO 35×45, Canada 50×70, China 33×48, or a custom size.
- **Two steps:** first adjust and check (crop, document, background, checks), then download.
- **Digital photo:** PNG or JPG at 300 or 600 DPI. The DPI is written into the file (JFIF / `pHYs`) so it prints at true size.
- **Print sheet:** 4×6, 5×7, A4 or Letter, as a **PDF** (true page size, the photo embedded once, vector cutting lines) or a 300 DPI **PNG/JPG**. The PDF is written by hand in `js/render.js`, with no PDF library.

> Automatic checks are a guide. Always confirm your country's official photo requirements.

## Why plain JavaScript (no React)

The UI is two screens. Plain ES modules mean no bundler and no runtime dependencies besides MediaPipe, so every line that ships can be read in the browser's devtools. That fits a privacy-first tool better than a framework build.

## Run locally

Requires Node.js 16 or newer.

```bash
npm install     # also copies the MediaPipe runtime and downloads the models (~35 MB, checksum-verified)
npm start       # http://localhost:8080
```

`npm start` runs a tiny zero-dependency static server bound to `127.0.0.1`. Any static server works. The webcam needs `localhost` or HTTPS.

## Deploy to GitHub Pages

1. Push to `main`.
2. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.

`.github/workflows/deploy.yml` runs `npm ci` (which fetches and verifies the models), then `npm run build`, and publishes `dist/`. All paths are relative, so the site works under `https://<user>.github.io/<repo>/`.

To preview the production build: `npm run build && npm run preview`.

## Project layout

```
index.html            page + Content-Security-Policy
css/styles.css
js/main.js            UI wiring and app state
js/ai.js              MediaPipe model loading, face detection, segmentation
js/geometry.js        face measurements, crop suggestion, compliance checks
js/matte.js           background mask refinement and cut-out
js/editor.js          interactive crop canvas
js/render.js          final photo, print sheets (PDF/JPG/PNG), DPI metadata, downloads
js/camera.js          webcam capture
js/presets.js         document sizes and rules
scripts/setup.mjs     vendors MediaPipe + downloads models (pinned SHA-256)
scripts/serve.mjs     local static server
scripts/build.mjs     assembles dist/ for deployment
```

`vendor/`, `models/` and `dist/` are generated and git-ignored.

## Third-party components

- [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) 1.2.3, Apache-2.0
- Face Landmarker and Selfie Multiclass models by Google (MediaPipe), Apache-2.0
