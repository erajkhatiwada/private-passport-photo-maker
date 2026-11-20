// Person matte for background replacement: segment a region, refine edges, build a cutout.
import { segmentPerson } from './ai.js';
import { axes } from './geometry.js';

const MAX_MATTE_SIDE = 1024; // processing resolution for the mask
const MAX_CUTOUT_SIDE = 2400; // resolution of the cut-out photo

// region: { x, y, w, h } in source pixels.
export function computeMatte(source, region) {
  const scale = Math.min(1, MAX_MATTE_SIDE / Math.max(region.w, region.h));
  const width = Math.max(1, Math.round(region.w * scale));
  const height = Math.max(1, Math.round(region.h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, width, height);

  const seg = segmentPerson(canvas);
  let alpha = seg.alpha;
  if (seg.width !== width || seg.height !== height) alpha = resizeNearest(alpha, seg.width, seg.height, width, height);

  // The model works at 256 px, so its edges are coarse. A colour-guided filter snaps them
  // to the real edges in the photo (hair, ears, shoulders).
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const r = Math.max(2, Math.round(Math.max(width, height) / 256));
  const refined = guidedFilterColor(rgba, alpha, width, height, r, 1e-3);
  for (let i = 0; i < refined.length; i++) refined[i] = Math.min(1, Math.max(0, refined[i]));
  canvas.width = 0;

  // rgba (the region at mask resolution) is kept for backgroundStats.
  return { region, scale, width, height, alpha: refined, rgba };
}

// Brightness and plainness of the original background inside the crop box, sampled on a
// grid. Only clear background counts: points where the mask, and the mask a little way
// around them, is not the person (keeps hair and soft edges out). Returns null when too
// little background is visible to judge.
export function backgroundStats(matte, box) {
  const N = 48;
  const { region, scale, width, height, alpha, rgba } = matte;
  const { e1, e2 } = axes(box.angle);
  const d = Math.max(2, Math.round(Math.max(width, height) / 128));
  // The mask stays around 0.05–0.1 on clear background, never 0.
  const isBg = (mx, my) => mx >= 0 && my >= 0 && mx < width && my < height && alpha[my * width + mx] < 0.2;
  const lum = new Float32Array(N * N).fill(NaN);
  const values = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = ((i + 0.5) / N - 0.5) * box.w;
      const v = ((j + 0.5) / N - 0.5) * box.h;
      const mx = Math.round((box.cx + e1.x * u + e2.x * v - region.x) * scale);
      const my = Math.round((box.cy + e1.y * u + e2.y * v - region.y) * scale);
      if (!isBg(mx, my) || !isBg(mx - d, my) || !isBg(mx + d, my) || !isBg(mx, my - d) || !isBg(mx, my + d)) continue;
      const k = (my * width + mx) * 4;
      const L = 0.2126 * rgba[k] + 0.7152 * rgba[k + 1] + 0.0722 * rgba[k + 2];
      lum[j * N + i] = L;
      values.push(L);
    }
  }
  if (values.length < N * N * 0.1) return null;

  values.sort((a, b) => a - b);
  const pct = (p) => values[Math.floor(p * (values.length - 1))];
  // Texture: share of neighbouring samples whose brightness jumps (patterns, objects, edges).
  // Smooth lighting falloff changes brightness only slowly, so it doesn't count.
  let pairs = 0;
  let jumps = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = lum[j * N + i];
      if (Number.isNaN(a)) continue;
      for (const b of [i + 1 < N ? lum[j * N + i + 1] : NaN, j + 1 < N ? lum[(j + 1) * N + i] : NaN]) {
        if (Number.isNaN(b)) continue;
        pairs++;
        if (Math.abs(a - b) > 12) jumps++;
      }
    }
  }
  return {
    luma: pct(0.5), // median brightness, 0–255
    spread: pct(0.95) - pct(0.05), // brightness range of the middle 90%
    busy: pairs ? jumps / pairs : 0,
  };
}

// edge: 0 (soft, keeps more hair) … 1 (tight, trims halos)
export function buildCutout(source, matte, edge) {
  const { region, width, height, alpha } = matte;
  const center = 0.3 + 0.4 * edge;
  const lo = center - 0.25;
  const hi = center + 0.25;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const mctx = maskCanvas.getContext('2d');
  const img = mctx.createImageData(width, height);
  for (let i = 0; i < alpha.length; i++) {
    let t = (alpha[i] - lo) / (hi - lo);
    t = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    img.data[i * 4 + 3] = Math.round(t * 255);
  }
  mctx.putImageData(img, 0, 0);

  const cs = Math.min(1, MAX_CUTOUT_SIDE / Math.max(region.w, region.h));
  const cutout = document.createElement('canvas');
  cutout.width = Math.max(1, Math.round(region.w * cs));
  cutout.height = Math.max(1, Math.round(region.h * cs));
  const ctx = cutout.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, cutout.width, cutout.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0, cutout.width, cutout.height);
  maskCanvas.width = 0;
  return cutout;
}

export function containsRect(outer, inner, tol = 2) {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.w <= outer.x + outer.w + tol &&
    inner.y + inner.h <= outer.y + outer.h + tol
  );
}

function resizeNearest(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) out[y * dw + x] = src[sy * sw + Math.min(sw - 1, Math.floor((x * sw) / dw))];
  }
  return out;
}

// Mean over a (2r+1)² window, using an integral image (handles borders exactly).
function boxMean(src, w, h, r) {
  const W = w + 1;
  const S = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      S[(y + 1) * W + x + 1] = S[y * W + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - r);
    const y2 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - r);
      const x2 = Math.min(w, x + r + 1);
      out[y * w + x] = (S[y2 * W + x2] - S[y1 * W + x2] - S[y2 * W + x1] + S[y1 * W + x1]) / ((x2 - x1) * (y2 - y1));
    }
  }
  return out;
}

// He et al., "Guided Image Filtering", with an RGB guide image.
function guidedFilterColor(rgba, p, w, h, r, eps) {
  const n = w * h;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    R[i] = rgba[i * 4] / 255;
    G[i] = rgba[i * 4 + 1] / 255;
    B[i] = rgba[i * 4 + 2] / 255;
  }
  const tmp = new Float32Array(n);
  const meanOf = (x, y) => {
    for (let i = 0; i < n; i++) tmp[i] = x[i] * y[i];
    return boxMean(tmp, w, h, r);
  };
  const mR = boxMean(R, w, h, r);
  const mG = boxMean(G, w, h, r);
  const mB = boxMean(B, w, h, r);
  const mP = boxMean(p, w, h, r);
  const mRP = meanOf(R, p);
  const mGP = meanOf(G, p);
  const mBP = meanOf(B, p);
  const mRR = meanOf(R, R);
  const mRG = meanOf(R, G);
  const mRB = meanOf(R, B);
  const mGG = meanOf(G, G);
  const mGB = meanOf(G, B);
  const mBB = meanOf(B, B);

  const aR = new Float32Array(n);
  const aG = new Float32Array(n);
  const aB = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cR = mRP[i] - mR[i] * mP[i];
    const cG = mGP[i] - mG[i] * mP[i];
    const cB = mBP[i] - mB[i] * mP[i];
    // Covariance of the guide colours (+ eps on the diagonal), inverted as a symmetric 3×3.
    const rr = mRR[i] - mR[i] * mR[i] + eps;
    const rg = mRG[i] - mR[i] * mG[i];
    const rb = mRB[i] - mR[i] * mB[i];
    const gg = mGG[i] - mG[i] * mG[i] + eps;
    const gb = mGB[i] - mG[i] * mB[i];
    const bb = mBB[i] - mB[i] * mB[i] + eps;
    const i00 = gg * bb - gb * gb;
    const i01 = gb * rb - rg * bb;
    const i02 = rg * gb - gg * rb;
    const i11 = rr * bb - rb * rb;
    const i12 = rb * rg - rr * gb;
    const i22 = rr * gg - rg * rg;
    const det = rr * i00 + rg * i01 + rb * i02;
    aR[i] = (i00 * cR + i01 * cG + i02 * cB) / det;
    aG[i] = (i01 * cR + i11 * cG + i12 * cB) / det;
    aB[i] = (i02 * cR + i12 * cG + i22 * cB) / det;
    b[i] = mP[i] - aR[i] * mR[i] - aG[i] * mG[i] - aB[i] * mB[i];
  }
  const maR = boxMean(aR, w, h, r);
  const maG = boxMean(aG, w, h, r);
  const maB = boxMean(aB, w, h, r);
  const mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = maR[i] * R[i] + maG[i] * G[i] + maB[i] * B[i] + mb[i];
  return q;
}
