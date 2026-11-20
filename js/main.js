import { PRESETS, SHEETS, resolvePreset } from './presets.js';
import { loadModels, detectFaces } from './ai.js';
import {
  analyzeFace, faceRegion, findCrown, suggestBox, defaultBox, headTarget, boxBounds, clipRect, runChecks,
} from './geometry.js';
import { computeMatte, buildCutout, containsRect, backgroundStats } from './matte.js';
import {
  drawCrop, renderPhoto, renderSheet, sheetLayout, sheetPdf, toJpegBlob, toPngBlob, downloadBlob, mmToPx,
} from './render.js';
import { CropEditor } from './editor.js';
import { Camera } from './camera.js';

const $ = (id) => document.getElementById(id);
const MAX_SOURCE_SIDE = 3000;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// Everything about the current photo lives here, in memory only.
const state = {
  source: null, // canvas with the (downscaled) photo
  box: null,
  bgMode: 'original',
  bgColor: '#ffffff',
  bgTouched: false,
  edge: 0.5,
  matte: null,
  cutout: null,
  region: null,
  face: null,
  faceCount: 0,
  crown: null,
  presetId: 'us',
  custom: { w: 35, h: 45 },
  dpi: 600,
  sheet: '4x6',
  photoFormat: 'png',
  sheetFormat: 'pdf',
};

// Print sheets are rasterised at 300 DPI (standard for photo printing); the PDF embeds
// the photo at 600 DPI and stays small because it is stored only once.
const SHEET_DPI = 300;
const PDF_PHOTO_DPI = 600;

const spec = () => resolvePreset(state.presetId, state.custom);

// ---------- AI models ----------
let aiReady = false;
const modelsReady = loadModels((p) => {
  $('modelStatusText').textContent = `Loading AI models (one-time download)… ${Math.round(p * 100)}%`;
})
  .then(() => {
    aiReady = true;
    $('modelStatus').classList.add('ready');
    $('modelStatusText').textContent = 'AI ready — running on your device. You can go offline now.';
  })
  .catch((err) => {
    console.error(err);
    $('modelStatus').classList.add('error');
    $('modelStatusText').textContent = 'The AI could not start in this browser. You can still crop by hand.';
  });

// ---------- editor ----------
const editor = new CropEditor($('editorCanvas'), {
  onChange: () => {
    renderPreview();
    renderChecks();
    syncRotate();
  },
  onCommit: () => ensureMatte(),
});

// ---------- opening a photo ----------
async function openFile(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) return toast('Please choose an image file (JPG, PNG, WebP…).');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    await openImage(img, img.naturalWidth, img.naturalHeight);
  } catch (err) {
    console.error(err);
    toast("This browser can't open that file. Try a JPG or PNG.");
  } finally {
    URL.revokeObjectURL(url);
    $('fileInput').value = '';
  }
}

async function openImage(drawable, w, h) {
  clearPhoto();
  const k = Math.min(1, MAX_SOURCE_SIDE / Math.max(w, h));
  const source = document.createElement('canvas');
  source.width = Math.round(w * k);
  source.height = Math.round(h * k);
  const ctx = source.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(drawable, 0, 0, source.width, source.height);
  state.source = source;

  showView('edit');
  editor.setScene(state);
  setBusy(aiReady ? 'Finding your face…' : 'Loading AI models…');
  await modelsReady;
  if (state.source !== source) return; // replaced while waiting
  setBusy('Finding your face…');
  await nextFrame();
  try {
    analyze();
  } catch (err) {
    console.error(err);
    state.face = null;
    applySuggestion();
    toast('The AI had trouble with this photo. You can still crop it by hand.');
  }
  setBusy(null);
  startNetworkWatch();
}

function analyze() {
  const { width: W, height: H } = state.source;
  state.face = null;
  state.crown = null;
  state.matte = null;
  state.faceCount = 0;
  if (aiReady) {
    const faces = detectFaces(state.source);
    state.faceCount = faces.length;
    if (faces.length) {
      state.face = analyzeFace(faces[0], W, H);
      state.matte = computeMatte(state.source, faceRegion(state.face, W, H));
      state.crown = findCrown(state.face, state.matte, W, H);
    }
  }
  applySuggestion();
}

// Put the crop box where the AI suggests for the selected document.
function applySuggestion() {
  if (!state.source) return;
  const s = spec();
  const { width: W, height: H } = state.source;
  state.box = state.face ? suggestBox(state.face, state.crown.point, s, W, H) : defaultBox(W, H, s);
  editor.spec = s;
  editor.guide = state.face ? headTarget(state.face, state.crown.point, s) : null;
  editor.markers = state.face
    ? { ...pick(state.face, 'eyeL', 'eyeR', 'chin', 'e1'), crown: state.crown.point }
    : null;
  editor.snapAngles = state.face ? [state.face.theta, 0] : [0];
  editor.fit(true);
  ensureMatte();
  editor.requestDraw();
}

// Make sure the background mask covers the crop box (recomputed when the box moves far).
let matteJob = Promise.resolve();
function ensureMatte() {
  matteJob = matteJob.then(ensureMatteNow);
  return matteJob;
}

async function ensureMatteNow() {
  const source = state.source;
  if (!source || !state.box || state.bgMode !== 'color') return;
  const { width: W, height: H } = source;
  const bb = boxBounds(state.box);
  const need = clipRect(bb, W, H);
  if (aiReady && !(state.matte && containsRect(state.matte.region, need))) {
    const g = 0.25;
    const region = clipRect({ x: bb.x - bb.w * g, y: bb.y - bb.h * g, w: bb.w * (1 + 2 * g), h: bb.h * (1 + 2 * g) }, W, H);
    setBusy('Removing background…');
    await nextFrame();
    if (state.source !== source) return;
    try {
      state.matte = computeMatte(source, region);
    } catch (err) {
      console.error(err);
      toast('Background removal failed for this photo.');
    }
    setBusy(null);
  }
  if (state.matte && (!state.cutout || state.region !== state.matte.region)) rebuildCutout();
}

function rebuildCutout() {
  if (!state.matte || state.bgMode !== 'color') return;
  if (state.cutout) state.cutout.width = 0;
  state.cutout = buildCutout(state.source, state.matte, state.edge);
  state.region = state.matte.region;
  editor.requestDraw();
}

// ---------- output ----------
function renderPreview() {
  const canvas = $('preview');
  if (!state.source || !state.box) return;
  const s = spec();
  const cssW = 132;
  const cssH = Math.round((cssW * s.h) / s.w);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  drawCrop(canvas.getContext('2d'), state, canvas.width, canvas.height);
  $('dims').textContent = `${s.size} · ${mmToPx(s.w, state.dpi)} × ${mmToPx(s.h, state.dpi)} px`;
}

const ICONS = { pass: '✓', warn: '!', fail: '✕', info: 'i' };

function renderChecks() {
  if (!state.source || !state.box) return;
  const s = spec();
  const list = runChecks({
    face: state.face,
    faceCount: state.faceCount,
    crown: state.crown,
    box: state.box,
    spec: s,
    W: state.source.width,
    H: state.source.height,
    outW: mmToPx(s.w, state.dpi),
    bgMode: state.bgMode,
    background: state.matte && state.bgMode !== 'color' ? backgroundStats(state.matte, state.box) : null,
  });
  setBgAttention(list.some((c) => c.fix === 'background'));
  const ul = $('checks');
  ul.replaceChildren(
    ...list.map((c) => {
      const li = document.createElement('li');
      li.className = c.status;
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = ICONS[c.status];
      const text = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = c.label;
      text.append(strong);
      if (c.detail && c.status !== 'pass') {
        const small = document.createElement('small');
        small.textContent = c.detail;
        text.append(small);
      }
      li.append(icon, text);
      return li;
    })
  );
  const fails = list.filter((c) => c.status === 'fail').length;
  const warns = list.filter((c) => c.status === 'warn').length;
  const summary = $('summary');
  summary.className = `summary ${fails ? 'fail' : warns ? 'warn' : 'pass'}`;
  summary.textContent = fails
    ? `${fails} problem${fails > 1 ? 's' : ''} to fix`
    : warns
      ? `Looks good — ${warns} thing${warns > 1 ? 's' : ''} to review`
      : 'Looks good!';
  const note = $('continueNote');
  note.hidden = !fails;
  note.textContent = fails
    ? `${fails} check${fails > 1 ? 's' : ''} failed. You can still continue, but the photo may be rejected.`
    : '';
  $('continueBtn').textContent = fails ? 'Continue to download anyway →' : 'Looks good — continue to download →';
}

function syncRotate() {
  if (!state.box) return;
  const deg = (state.box.angle * 180) / Math.PI;
  $('rotate').value = deg.toFixed(1);
  $('rotateOut').textContent = `${deg.toFixed(1)}°`;
}

const SHEET_NAMES = { pdf: 'PDF', jpg: 'JPG', png: 'PNG' };

function updateDownloadInfo() {
  const s = spec();
  const layout = sheetLayout(s, state.sheet);
  const paper = SHEETS[state.sheet].label.split(' (')[0];
  $('photoInfo').textContent =
    `${mmToPx(s.w, state.dpi)} × ${mmToPx(s.h, state.dpi)} px at ${state.dpi} DPI — prints at exactly ${s.size}.` +
    (state.photoFormat === 'png' ? ' PNG is lossless but larger.' : '');
  $('sheetInfo').textContent = layout.count
    ? `${layout.count} photo${layout.count > 1 ? 's' : ''} on ${paper}.` +
      (state.sheetFormat === 'pdf'
        ? ' Print at 100% / “Actual size” so the photos come out at the right size.'
        : ` ${SHEET_DPI} DPI image — order it as a ${paper} print.`)
    : 'This photo size is too large for that paper.';
  $('downloadSheet').disabled = !layout.count;
  $('downloadPhoto').textContent = `Download photo (${SHEET_NAMES[state.photoFormat]})`;
  $('downloadSheet').textContent = `Download print sheet (${SHEET_NAMES[state.sheetFormat]})`;
  $('finalCaption').textContent = `${s.size} · ${mmToPx(s.w, state.dpi)} × ${mmToPx(s.h, state.dpi)} px`;
  $('sheetCaption').textContent = layout.count ? `${layout.count} × on ${paper}` : '';
}

function renderDownloadPreviews() {
  if (!state.box || $('downloadView').hidden) return;
  const s = spec();
  const dpr = window.devicePixelRatio || 1;
  const stage = $('dlStage');
  const narrow = stage.clientWidth < 640;

  // The photo, at a comfortable on-screen size.
  const photoCss = narrow ? 200 : 280;
  const pw = Math.round(s.w >= s.h ? photoCss : (photoCss * s.w) / s.h);
  const ph = Math.round((pw * s.h) / s.w);
  const final = $('finalPreview');
  final.style.width = `${pw}px`;
  final.style.height = `${ph}px`;
  final.width = Math.round(pw * dpr);
  final.height = Math.round(ph * dpr);
  drawCrop(final.getContext('2d'), state, final.width, final.height);

  // The print sheet, scaled to fit the stage.
  const layout = sheetLayout(s, state.sheet);
  const sheetCanvas = $('sheetPreview');
  const maxW = Math.min(560, stage.clientWidth - 48);
  const sw = Math.max(120, Math.round(Math.min(maxW, (maxW * 0.9 * layout.w) / layout.h)));
  const dpi = Math.min(300, ((sw * dpr) / layout.w) * 25.4);
  const photo = renderPhoto(state, s, dpi);
  const sheet = renderSheet(photo, layout, dpi);
  sheetCanvas.width = sheet.width;
  sheetCanvas.height = sheet.height;
  sheetCanvas.style.width = `${sw}px`;
  sheetCanvas.style.height = `${Math.round((sw * layout.h) / layout.w)}px`;
  sheetCanvas.getContext('2d').drawImage(sheet, 0, 0);
  photo.width = 0;
  sheet.width = 0;
  updateDownloadInfo();
}

const encode = (canvas, format, dpi) => (format === 'png' ? toPngBlob(canvas, dpi) : toJpegBlob(canvas, dpi));

async function downloadPhoto() {
  if (!state.box) return;
  const s = spec();
  const photo = renderPhoto(state, s, state.dpi);
  const blob = await encode(photo, state.photoFormat, state.dpi);
  downloadBlob(blob, `passport-photo-${s.id}-${photo.width}x${photo.height}.${state.photoFormat}`);
  photo.width = 0;
}

async function downloadSheet() {
  if (!state.box) return;
  const s = spec();
  const layout = sheetLayout(s, state.sheet);
  if (!layout.count) return;
  const name = `passport-photos-${s.id}-${state.sheet}-${layout.count}up.${state.sheetFormat}`;
  if (state.sheetFormat === 'pdf') {
    const photo = renderPhoto(state, s, PDF_PHOTO_DPI);
    const jpeg = new Uint8Array(await (await toJpegBlob(photo, PDF_PHOTO_DPI)).arrayBuffer());
    downloadBlob(sheetPdf(jpeg, photo.width, photo.height, layout), name);
    photo.width = 0;
    return;
  }
  const photo = renderPhoto(state, s, SHEET_DPI);
  const canvas = renderSheet(photo, layout, SHEET_DPI);
  downloadBlob(await encode(canvas, state.sheetFormat, SHEET_DPI), name);
  photo.width = 0;
  canvas.width = 0;
}

// ---------- UI state ----------
// view: 'start' | 'edit' | 'download'
function showView(view) {
  $('startView').hidden = view !== 'start';
  $('editorView').hidden = view !== 'edit';
  $('downloadView').hidden = view !== 'download';
  document.body.classList.toggle('editing', view !== 'start');
  window.scrollTo(0, 0);
  if (view === 'edit') requestAnimationFrame(() => editor.resize());
  if (view === 'download') renderDownloadPreviews();
}

function setBusy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

function clearPhoto() {
  for (const c of [state.source, state.cutout]) if (c) c.width = 0;
  Object.assign(state, {
    source: null, box: null, matte: null, cutout: null, region: null, face: null, faceCount: 0, crown: null,
  });
  editor.markers = null;
  editor.guide = null;
  setBusy(null);
  for (const id of ['preview', 'finalPreview', 'sheetPreview']) $(id).width = 0;
  $('checks').replaceChildren();
  setBgAttention(false);
  stopNetworkWatch();
}

// Highlight the Background card when the original background fails its check.
function setBgAttention(on) {
  $('bgCard').classList.toggle('attention', on);
  $('bgHint').hidden = !on;
}

function setBgMode(mode) {
  state.bgMode = mode;
  for (const b of document.querySelectorAll('.segmented [data-bg]')) {
    const on = b.dataset.bg === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }
  $('bgOptions').hidden = mode !== 'color';
  if (mode === 'color' && !aiReady) toast('Background replacement needs the AI, which is still loading or unavailable.');
  ensureMatte();
  editor.requestDraw();
}

function setBgColor(color, touched = true) {
  state.bgColor = color;
  if (touched) state.bgTouched = true;
  $('bgColor').value = color;
  for (const sw of document.querySelectorAll('.swatch[data-color]')) {
    sw.classList.toggle('active', sw.dataset.color.toLowerCase() === color.toLowerCase());
  }
  editor.requestDraw();
}

function updateSpecText() {
  const s = spec();
  $('specText').textContent = `${s.size}. ${s.note}`;
  $('customFields').hidden = !s.custom;
  if (!state.bgTouched) setBgColor(s.bg, false);
  updateDownloadInfo();
}

// ---------- privacy: count network requests made after the photo was added ----------
let watchStart = null;
let netRequests = 0;
try {
  new PerformanceObserver((list) => {
    if (watchStart === null) return;
    for (const e of list.getEntries()) {
      if (e.startTime >= watchStart && !/^(blob|data):/.test(e.name)) netRequests++;
    }
    updateNetCount();
  }).observe({ type: 'resource', buffered: false });
} catch {
  /* PerformanceObserver unsupported */
}
function startNetworkWatch() {
  watchStart = performance.now();
  netRequests = 0;
  updateNetCount();
}
function stopNetworkWatch() {
  watchStart = null;
  updateNetCount();
}
function updateNetCount() {
  const text =
    watchStart === null
      ? 'Network requests since you added your photo: — (no photo yet)'
      : `Network requests since you added your photo: ${netRequests}`;
  $('netCount').textContent = text;
  // While a photo is open, the top bar shows the live counter in place of the privacy pill.
  const pill = $('netPill');
  pill.hidden = watchStart === null;
  $('privacyBtn').hidden = watchStart !== null;
  pill.title = text;
  pill.setAttribute('aria-label', text);
  $('netPillCount').textContent = netRequests;
  $('netPillLabel').textContent = netRequests === 1 ? ' network request' : ' network requests';
}

const pick = (o, ...keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// ---------- wire up ----------
function init() {
  const presetSel = $('preset');
  for (const p of PRESETS) {
    const text = p.custom ? p.label : `${p.label} (${p.size})`;
    presetSel.add(new Option(`${p.flag} ${text}`, p.id));
  }
  presetSel.value = state.presetId;
  presetSel.addEventListener('change', () => {
    state.presetId = presetSel.value;
    updateSpecText();
    applySuggestion();
  });
  for (const id of ['customW', 'customH']) {
    $(id).addEventListener('change', () => {
      state.custom = { w: $('customW').value, h: $('customH').value };
      updateSpecText();
      applySuggestion();
    });
  }

  const sheetSel = $('sheet');
  for (const [id, sh] of Object.entries(SHEETS)) sheetSel.add(new Option(sh.label, id));
  sheetSel.value = state.sheet;
  sheetSel.addEventListener('change', () => {
    state.sheet = sheetSel.value;
    renderDownloadPreviews();
    updateDownloadInfo();
  });
  $('dpi').addEventListener('change', (e) => {
    state.dpi = Number(e.target.value);
    renderPreview();
    renderChecks();
    updateDownloadInfo();
  });
  for (const group of document.querySelectorAll('.segmented[data-group]')) {
    const buttons = group.querySelectorAll('[data-value]');
    for (const b of buttons) {
      b.addEventListener('click', () => {
        state[group.dataset.group] = b.dataset.value;
        for (const o of buttons) {
          o.classList.toggle('active', o === b);
          o.setAttribute('aria-checked', String(o === b));
        }
        updateDownloadInfo();
      });
    }
  }
  $('continueBtn').addEventListener('click', () => showView('download'));
  for (const id of ['backBtn', 'backStep']) $(id).addEventListener('click', () => showView('edit'));
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderDownloadPreviews, 150);
  });

  $('fileInput').addEventListener('change', (e) => openFile(e.target.files[0]));
  const dz = $('dropzone');
  for (const ev of ['dragenter', 'dragover']) {
    window.addEventListener(ev, (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dz.classList.add('dragging');
    });
  }
  for (const ev of ['dragleave', 'drop']) window.addEventListener(ev, () => dz.classList.remove('dragging'));
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    openFile(e.dataTransfer.files[0]);
  });

  const camera = new Camera(
    {
      dialog: $('cameraDialog'),
      video: $('camVideo'),
      shoot: $('camShoot'),
      cancel: $('camCancel'),
      switchBtn: $('camSwitch'),
      timer: $('camTimer'),
      count: $('camCount'),
      error: $('camError'),
    },
    (canvas) => openImage(canvas, canvas.width, canvas.height).finally(() => (canvas.width = 0))
  );
  $('webcamBtn').addEventListener('click', () => camera.open());

  $('zoomIn').addEventListener('click', () => editor.zoom(1.08));
  $('zoomOut').addEventListener('click', () => editor.zoom(1 / 1.08));
  $('rotate').addEventListener('input', (e) => {
    if (!state.box) return;
    editor.setAngle((Number(e.target.value) * Math.PI) / 180, false);
    editor.requestDraw();
    editor.scheduleCommit();
  });
  $('guidesToggle').addEventListener('change', (e) => {
    editor.showGuides = e.target.checked;
    editor.requestDraw();
  });
  $('resetBtn').addEventListener('click', applySuggestion);

  for (const b of document.querySelectorAll('.segmented [data-bg]')) {
    b.addEventListener('click', () => setBgMode(b.dataset.bg));
  }
  for (const sw of document.querySelectorAll('.swatch[data-color]')) {
    sw.addEventListener('click', () => setBgColor(sw.dataset.color));
  }
  $('bgColor').addEventListener('input', (e) => setBgColor(e.target.value));
  let edgeTimer = 0;
  $('edge').addEventListener('input', (e) => {
    state.edge = Number(e.target.value) / 100;
    clearTimeout(edgeTimer);
    edgeTimer = setTimeout(rebuildCutout, 60);
  });

  $('downloadPhoto').addEventListener('click', downloadPhoto);
  $('downloadSheet').addEventListener('click', downloadSheet);
  for (const id of ['startOver', 'startOver2']) {
    $(id).addEventListener('click', () => {
      clearPhoto();
      showView('start');
      editor.draw();
    });
  }

  const privacy = $('privacyDialog');
  for (const id of ['privacyBtn', 'privacyLink', 'netPill']) $(id).addEventListener('click', () => privacy.showModal());
  $('privacyClose').addEventListener('click', () => privacy.close());

  updateSpecText();
  updateNetCount();
}

init();
