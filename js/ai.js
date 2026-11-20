// On-device AI: MediaPipe Face Landmarker (face, eyes, chin, expression, head pose)
// and the Selfie Multiclass segmenter (person vs. background). Every file is served
// from this site; the page's Content-Security-Policy blocks requests to anywhere else.
import { FilesetResolver, FaceLandmarker, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.mjs';

const asset = (path) => new URL(path, import.meta.url).href;
const WASM_DIR = asset('../vendor/mediapipe/wasm');
const FACE_MODEL = asset('../models/face_landmarker.task');
const SEG_MODEL = asset('../models/selfie_multiclass_256x256.tflite');

let landmarker = null;
let segmenter = null;

// Fetch a model ourselves so we can show download progress.
// Content-Length is only an estimate: hosts like GitHub Pages serve gzip, so it is the
// compressed size while the stream yields decompressed bytes. Never size buffers from it.
async function fetchWithProgress(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onBytes(buf.length, buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes(got, Math.max(total, got));
  }
  const out = new Uint8Array(got);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function createWithFallback(create) {
  try {
    return await create('GPU');
  } catch (err) {
    console.warn('GPU delegate unavailable, falling back to CPU', err);
    return create('CPU');
  }
}

export async function loadModels(onProgress = () => {}) {
  const progress = { face: [0, 1], seg: [0, 1] };
  const report = () => {
    const done = progress.face[0] + progress.seg[0];
    const total = progress.face[1] + progress.seg[1];
    onProgress(total ? done / total : 0);
  };
  const [fileset, faceBuf, segBuf] = await Promise.all([
    FilesetResolver.forVisionTasks(WASM_DIR),
    fetchWithProgress(FACE_MODEL, (g, t) => { progress.face = [g, t]; report(); }),
    fetchWithProgress(SEG_MODEL, (g, t) => { progress.seg = [g, t]; report(); }),
  ]);

  landmarker = await createWithFallback((delegate) =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: faceBuf, delegate },
      runningMode: 'IMAGE',
      numFaces: 4,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    })
  );
  segmenter = await createWithFallback((delegate) =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: segBuf, delegate },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })
  );
}

// Returns faces with landmarks normalised to the full image, largest face first.
// If nothing is found (face small in a large photo), retries on zoomed-in tiles.
export function detectFaces(canvas) {
  let faces = runLandmarker(canvas, 0, 0, canvas.width, canvas.height, canvas.width, canvas.height);
  if (!faces.length) {
    const W = canvas.width;
    const H = canvas.height;
    const s = 0.6;
    const tiles = [
      [0.2, 0.1], [0, 0], [1 - s, 0], [0, 1 - s], [1 - s, 1 - s],
    ];
    for (const [fx, fy] of tiles) {
      const tile = document.createElement('canvas');
      tile.width = Math.round(W * s);
      tile.height = Math.round(H * s);
      const x0 = Math.round(W * fx);
      const y0 = Math.round(H * fy);
      tile.getContext('2d').drawImage(canvas, x0, y0, tile.width, tile.height, 0, 0, tile.width, tile.height);
      faces = runLandmarker(tile, x0, y0, tile.width, tile.height, W, H);
      tile.width = 0;
      if (faces.length) break;
    }
  }
  return faces.sort((a, b) => faceArea(b) - faceArea(a));
}

function runLandmarker(input, x0, y0, w, h, W, H) {
  const res = landmarker.detect(input);
  return (res.faceLandmarks || []).map((lm, i) => ({
    landmarks: lm.map((p) => ({ x: (p.x * w + x0) / W, y: (p.y * h + y0) / H })),
    blendshapes: Object.fromEntries(
      (res.faceBlendshapes?.[i]?.categories || []).map((c) => [c.categoryName, c.score])
    ),
    matrix: res.facialTransformationMatrixes?.[i]?.data || null,
  }));
}

function faceArea(f) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of f.landmarks) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return (maxX - minX) * (maxY - minY);
}

// Person probability (0..1) for every pixel of `canvas`.
export function segmentPerson(canvas) {
  const res = segmenter.segment(canvas);
  try {
    const masks = res.confidenceMasks || [];
    const first = masks[0].getAsFloat32Array();
    const alpha = new Float32Array(first.length);
    if (masks.length > 1) {
      // Multiclass model: class 0 is background, everything else is the person.
      for (let i = 0; i < first.length; i++) alpha[i] = 1 - first[i];
    } else {
      alpha.set(first);
    }
    return { alpha, width: masks[0].width, height: masks[0].height };
  } finally {
    res.close();
  }
}
