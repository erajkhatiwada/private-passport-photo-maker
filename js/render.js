// Final output: the cropped photo, print sheets and downloads (all generated locally).
import { SHEETS } from './presets.js';

export const MM_PER_INCH = 25.4;
export const mmToPx = (mm, dpi) => Math.round((mm / MM_PER_INCH) * dpi);

// Draws the crop `box` of the scene into a w×h area of ctx.
// scene: { source, box, bgMode, bgColor, cutout, region }
export function drawCrop(ctx, scene, w, h) {
  const { source, box, bgMode, bgColor, cutout, region } = scene;
  const useCutout = bgMode === 'color' && cutout;
  ctx.save();
  ctx.fillStyle = useCutout ? bgColor : '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.scale(w / box.w, h / box.h);
  ctx.rotate(-box.angle);
  ctx.translate(-box.cx, -box.cy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (useCutout) ctx.drawImage(cutout, region.x, region.y, region.w, region.h);
  else ctx.drawImage(source, 0, 0);
  ctx.restore();
}

export function renderPhoto(scene, spec, dpi) {
  const canvas = document.createElement('canvas');
  canvas.width = mmToPx(spec.w, dpi);
  canvas.height = mmToPx(spec.h, dpi);
  drawCrop(canvas.getContext('2d'), scene, canvas.width, canvas.height);
  return canvas;
}

// Fits as many photos as possible on the sheet (trying both orientations). All in mm.
export function sheetLayout(spec, sheetId) {
  const sheet = SHEETS[sheetId] || SHEETS['4x6'];
  const margin = 3;
  const gap = 2;
  const fit = (sw, sh) => ({
    sw,
    sh,
    cols: Math.max(0, Math.floor((sw - 2 * margin + gap) / (spec.w + gap))),
    rows: Math.max(0, Math.floor((sh - 2 * margin + gap) / (spec.h + gap))),
  });
  const a = fit(sheet.w, sheet.h);
  const b = fit(sheet.h, sheet.w);
  const best = b.cols * b.rows > a.cols * a.rows ? b : a;
  const x0 = (best.sw - (best.cols * spec.w + (best.cols - 1) * gap)) / 2;
  const y0 = (best.sh - (best.rows * spec.h + (best.rows - 1) * gap)) / 2;
  const cells = [];
  for (let r = 0; r < best.rows; r++) {
    for (let c = 0; c < best.cols; c++) cells.push({ x: x0 + c * (spec.w + gap), y: y0 + r * (spec.h + gap) });
  }
  return { sheet, w: best.sw, h: best.sh, photoW: spec.w, photoH: spec.h, cells, count: cells.length };
}

// Raster print sheet with thin cutting guides.
export function renderSheet(photo, layout, dpi) {
  const canvas = document.createElement('canvas');
  canvas.width = mmToPx(layout.w, dpi);
  canvas.height = mmToPx(layout.h, dpi);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const pw = mmToPx(layout.photoW, dpi);
  const ph = mmToPx(layout.photoH, dpi);
  ctx.imageSmoothingQuality = 'high';
  ctx.strokeStyle = '#b8b8b8';
  ctx.lineWidth = Math.max(1, Math.round(dpi / 300));
  const lw = ctx.lineWidth;
  for (const cell of layout.cells) {
    const x = mmToPx(cell.x, dpi);
    const y = mmToPx(cell.y, dpi);
    ctx.drawImage(photo, x, y, pw, ph);
    ctx.strokeRect(x - lw / 2, y - lw / 2, pw + lw, ph + lw);
  }
  return canvas;
}

// One-page PDF at the true sheet size: the photo is embedded once (JPEG) and placed in
// every cell, with vector cutting lines.
export function sheetPdf(jpegBytes, imgW, imgH, layout) {
  const pt = (mm) => (mm / MM_PER_INCH) * 72;
  const f = (n) => n.toFixed(3);
  const W = pt(layout.w);
  const H = pt(layout.h);
  const pw = pt(layout.photoW);
  const ph = pt(layout.photoH);
  let content = '0.72 G 0.5 w\n';
  for (const c of layout.cells) {
    const x = pt(c.x);
    const y = H - pt(c.y) - ph; // PDF origin is bottom-left
    content += `q ${f(pw)} 0 0 ${f(ph)} ${f(x)} ${f(y)} cm /Im0 Do Q\n`;
    content += `${f(x - 0.25)} ${f(y - 0.25)} ${f(pw + 0.5)} ${f(ph + 0.5)} re S\n`;
  }

  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let len = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    len += bytes.length;
  };
  const obj = (n, dict, stream) => {
    offsets[n] = len;
    push(`${n} 0 obj\n${dict}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };
  const contentBytes = enc.encode(content);
  push('%PDF-1.4\n%âãÏÓ\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>`, jpegBytes);
  obj(5, `<< /Length ${contentBytes.length} >>`, contentBytes);
  const xref = len;
  let tail = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) tail += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(tail);
  return new Blob(chunks, { type: 'application/pdf' });
}

const canvasBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// JPEG with the print resolution written into the JFIF header, so it prints at true size.
export async function toJpegBlob(canvas, dpi, quality = 0.95) {
  const bytes = new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', quality)).arrayBuffer());
  const isJfif =
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] === 0xe0 &&
    String.fromCharCode(...bytes.subarray(6, 10)) === 'JFIF';
  if (isJfif) {
    bytes[13] = 1; // density unit: dots per inch
    bytes[14] = dpi >> 8;
    bytes[15] = dpi & 0xff;
    bytes[16] = dpi >> 8;
    bytes[17] = dpi & 0xff;
  }
  return new Blob([bytes], { type: 'image/jpeg' });
}

// PNG with a pHYs chunk carrying the print resolution.
export async function toPngBlob(canvas, dpi) {
  const bytes = new Uint8Array(await (await canvasBlob(canvas, 'image/png')).arrayBuffer());
  const type = (at) => String.fromCharCode(...bytes.subarray(at + 4, at + 8));
  if (type(8) !== 'IHDR') return new Blob([bytes], { type: 'image/png' });
  const view = new DataView(bytes.buffer);
  for (let at = 8; at + 8 <= bytes.length; at += 12 + view.getUint32(at)) {
    if (type(at) === 'pHYs') return new Blob([bytes], { type: 'image/png' });
    if (type(at) === 'IDAT') break;
  }
  const ppm = Math.round(dpi / 0.0254); // pixels per metre
  const chunk = new Uint8Array(21);
  const cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  cv.setUint32(8, ppm);
  cv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  cv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const afterIhdr = 8 + 12 + view.getUint32(8);
  return new Blob([bytes.subarray(0, afterIhdr), chunk, bytes.subarray(afterIhdr)], { type: 'image/png' });
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
