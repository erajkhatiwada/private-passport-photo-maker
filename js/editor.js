// Interactive crop editor: shows the photo with the (rotatable) crop box, guides and
// the features the AI found. Drag to move, corners to resize, top knob to rotate,
// wheel / pinch to zoom, arrow keys to nudge.
import { axes, boxBounds, boxCorners } from './geometry.js';

const ROT_KNOB = 30; // px above the box
const DEG = Math.PI / 180;

export class CropEditor {
  constructor(canvas, { onChange, onCommit }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.onCommit = onCommit;
    this.scene = null; // shared state object owned by main.js
    this.spec = null;
    this.guide = null; // { crownY, chinY, headMm } in mm from the box top
    this.markers = null; // { eyeL, eyeR, chin, crown, e1 } in source px
    this.showGuides = true;
    this.snapAngles = [0];
    this.view = { s: 1, ox: 0, oy: 0 };
    this.fitTo = null;
    this.pointers = new Map();
    this.drag = null;
    this.frame = 0;
    this.commitTimer = 0;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('keydown', (e) => this.onKey(e));
  }

  setScene(scene) {
    this.scene = scene;
    this.fit(true);
  }

  // Fit the photo (and optionally the crop box) into the view.
  fit(includeBox) {
    const src = this.scene?.source;
    if (!src) return;
    let b = { x: 0, y: 0, w: src.width, h: src.height };
    if (includeBox && this.scene.box) {
      const bb = boxBounds(this.scene.box);
      const x = Math.min(b.x, bb.x);
      const y = Math.min(b.y, bb.y);
      b = { x, y, w: Math.max(b.x + b.w, bb.x + bb.w) - x, h: Math.max(b.y + b.h, bb.y + bb.h) - y };
    }
    this.fitTo = b;
    this.layout();
    this.draw();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    this.cssW = parent.clientWidth;
    this.cssH = parent.clientHeight;
    this.canvas.width = Math.max(1, Math.round(this.cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(this.cssH * dpr));
    this.dpr = dpr;
    this.layout();
    this.draw();
  }

  layout() {
    const b = this.fitTo;
    if (!b || !this.cssW) return;
    const pad = Math.min(40, this.cssW * 0.06) + ROT_KNOB * 0.5;
    const s = Math.min((this.cssW - 2 * pad) / b.w, (this.cssH - 2 * pad) / b.h);
    this.view = { s, ox: (this.cssW - b.w * s) / 2 - b.x * s, oy: (this.cssH - b.h * s) / 2 - b.y * s };
  }

  toView(p) {
    return { x: this.view.ox + p.x * this.view.s, y: this.view.oy + p.y * this.view.s };
  }

  toImage(x, y) {
    return { x: (x - this.view.ox) / this.view.s, y: (y - this.view.oy) / this.view.s };
  }

  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
      this.onChange?.();
    });
  }

  scheduleCommit() {
    clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => this.onCommit?.(), 300);
  }

  // ---------- drawing ----------
  draw() {
    const { ctx, canvas, scene } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!scene?.source || !this.cssW) return;
    const dpr = this.dpr;
    const { s, ox, oy } = this.view;
    const box = scene.box;

    // Photo
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scene.source, 0, 0);
    if (!box) return;

    const corners = boxCorners(box);
    // Inside the box: show exactly what the final photo will contain.
    ctx.save();
    pathPoly(ctx, corners);
    ctx.clip();
    const useCutout = scene.bgMode === 'color' && scene.cutout;
    ctx.fillStyle = useCutout ? scene.bgColor : '#ffffff';
    pathPoly(ctx, corners);
    ctx.fill();
    if (useCutout) ctx.drawImage(scene.cutout, scene.region.x, scene.region.y, scene.region.w, scene.region.h);
    else ctx.drawImage(scene.source, 0, 0);
    ctx.restore();

    // Dim everything outside the box.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vc = corners.map((p) => this.toView(p));
    ctx.beginPath();
    ctx.rect(0, 0, this.cssW, this.cssH);
    pathPoly(ctx, vc, false);
    ctx.fillStyle = 'rgba(10, 14, 22, 0.58)';
    ctx.fill('evenodd');

    if (this.showGuides) {
      this.drawGuides(box);
      this.drawMarkers();
    }

    // Box outline
    ctx.lineJoin = 'round';
    pathPoly(ctx, vc);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Rotate knob
    const { e2 } = axes(box.angle);
    const topMid = { x: (vc[0].x + vc[1].x) / 2, y: (vc[0].y + vc[1].y) / 2 };
    const knob = { x: topMid.x - e2.x * ROT_KNOB, y: topMid.y - e2.y * ROT_KNOB };
    ctx.beginPath();
    ctx.moveTo(topMid.x, topMid.y);
    ctx.lineTo(knob.x, knob.y);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    handle(ctx, knob, 8, true);
    for (const c of vc) handle(ctx, c, 7, false);
  }

  drawGuides(box) {
    const { ctx, spec, guide } = this;
    if (!spec) return;
    const ppm = box.w / spec.w;
    const k = ppm * this.view.s; // view px per mm
    const c = this.toView({ x: box.cx, y: box.cy });
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(box.angle);
    ctx.scale(k, k);
    ctx.translate(-spec.w / 2, -spec.h / 2);
    const px = 1 / k;

    // Centre line
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = px;
    line(ctx, spec.w / 2, 0, spec.w / 2, spec.h);

    // Allowed eye-line band
    if (spec.eyeFromBottom) {
      const [eMin, eMax] = spec.eyeFromBottom;
      ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
      ctx.fillRect(0, spec.h - eMax, spec.w, eMax - eMin);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
      line(ctx, 0, spec.h - eMax, spec.w, spec.h - eMax);
      line(ctx, 0, spec.h - eMin, spec.w, spec.h - eMin);
      label(ctx, 'eyes', 1.2, spec.h - eMax - 1, px, 'rgba(186, 230, 253, 0.95)');
    }

    if (guide) {
      // Target head outline
      const cy = (guide.crownY + guide.chinY) / 2;
      const ry = guide.headMm / 2;
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.95)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.ellipse(spec.w / 2, cy, ry * 0.74, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = px;
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.7)';
      line(ctx, spec.w * 0.3, guide.crownY, spec.w * 0.7, guide.crownY);
      line(ctx, spec.w * 0.3, guide.chinY, spec.w * 0.7, guide.chinY);
      label(ctx, 'top of head', spec.w / 2, guide.crownY - 3 * px, px, 'rgba(167, 243, 208, 0.95)', 'center');
      label(ctx, 'chin', spec.w / 2, guide.chinY + 12 * px, px, 'rgba(167, 243, 208, 0.95)', 'center');
    }
    ctx.restore();
  }

  drawMarkers() {
    const m = this.markers;
    if (!m) return;
    const { ctx } = this;
    ctx.save();
    ctx.setLineDash([]);
    const tick = (p, color) => {
      const v = this.toView(p);
      const dx = m.e1.x * 14;
      const dy = m.e1.y * 14;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 4;
      line(ctx, v.x - dx, v.y - dy, v.x + dx, v.y + dy);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      line(ctx, v.x - dx, v.y - dy, v.x + dx, v.y + dy);
    };
    tick(m.crown, '#fbbf24');
    tick(m.chin, '#fbbf24');
    for (const e of [m.eyeL, m.eyeR]) {
      const v = this.toView(e);
      ctx.beginPath();
      ctx.arc(v.x, v.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fbbf24';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- interaction ----------
  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hit(v, pointerType) {
    const box = this.scene?.box;
    if (!box) return null;
    const p = this.toImage(v.x, v.y);
    const { e1, e2 } = axes(box.angle);
    const d = { x: p.x - box.cx, y: p.y - box.cy };
    const lx = d.x * e1.x + d.y * e1.y;
    const ly = d.x * e2.x + d.y * e2.y;
    const s = this.view.s;
    const r = (pointerType === 'touch' ? 22 : 12) / s;
    if (Math.hypot(lx, ly + box.h / 2 + ROT_KNOB / s) <= r) return 'rotate';
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      if (Math.hypot(lx - (cx * box.w) / 2, ly - (cy * box.h) / 2) <= r) return 'resize';
    }
    if (Math.abs(lx) <= box.w / 2 && Math.abs(ly) <= box.h / 2) return 'move';
    return null;
  }

  onDown(e) {
    if (!this.scene?.box) return;
    const v = this.pos(e);
    this.pointers.set(e.pointerId, v);
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus({ preventScroll: true });
    const box = this.scene.box;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { mode: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), box0: { ...box } };
      return;
    }
    const mode = this.hit(v, e.pointerType);
    this.drag = mode ? { mode, start: this.toImage(v.x, v.y), box0: { ...box } } : null;
    if (mode) e.preventDefault();
  }

  onMove(e) {
    const v = this.pos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, v);
    const drag = this.drag;
    if (!drag) {
      const mode = this.hit(v, e.pointerType);
      this.canvas.style.cursor = { move: 'move', resize: 'nwse-resize', rotate: 'grab' }[mode] || 'default';
      return;
    }
    const box = this.scene.box;
    const b0 = drag.box0;
    const p = this.toImage(v.x, v.y);
    if (drag.mode === 'move') {
      box.cx = b0.cx + p.x - drag.start.x;
      box.cy = b0.cy + p.y - drag.start.y;
    } else if (drag.mode === 'resize') {
      const k = Math.hypot(p.x - b0.cx, p.y - b0.cy) / Math.max(1e-6, Math.hypot(drag.start.x - b0.cx, drag.start.y - b0.cy));
      this.setScale(b0, k);
    } else if (drag.mode === 'rotate') {
      this.setAngle(Math.atan2(p.y - b0.cy, p.x - b0.cx) + Math.PI / 2);
    } else if (drag.mode === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.setScale(b0, Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, drag.dist));
    }
    this.requestDraw();
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.drag) {
      this.drag = null;
      this.onCommit?.();
    }
  }

  onWheel(e) {
    if (!this.scene?.box) return;
    e.preventDefault();
    this.zoom(Math.exp(-e.deltaY * 0.0015));
  }

  onKey(e) {
    const box = this.scene?.box;
    if (!box) return;
    const step = (e.shiftKey ? 10 : 1) / this.view.s;
    const actions = {
      ArrowLeft: () => (box.cx -= step),
      ArrowRight: () => (box.cx += step),
      ArrowUp: () => (box.cy -= step),
      ArrowDown: () => (box.cy += step),
      '+': () => this.setScale({ ...box }, 1 / 1.02),
      '=': () => this.setScale({ ...box }, 1 / 1.02),
      '-': () => this.setScale({ ...box }, 1.02),
      '[': () => this.setAngle(box.angle - 0.5 * DEG, false),
      ']': () => this.setAngle(box.angle + 0.5 * DEG, false),
    };
    const fn = actions[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
    this.requestDraw();
    this.scheduleCommit();
  }

  // Zoom the photo in (k > 1) by shrinking the crop box.
  zoom(k) {
    const box = this.scene?.box;
    if (!box) return;
    this.setScale({ ...box }, 1 / k);
    this.requestDraw();
    this.scheduleCommit();
  }

  setScale(b0, k) {
    const box = this.scene.box;
    const minW = 24 / this.view.s;
    const maxW = Math.max(this.scene.source.width, this.scene.source.height) * 3;
    const w = Math.min(maxW, Math.max(minW, b0.w * k));
    box.h = (b0.h * w) / b0.w;
    box.w = w;
  }

  setAngle(a, snap = true) {
    a = Math.atan2(Math.sin(a), Math.cos(a));
    if (snap) {
      for (const t of this.snapAngles) if (Math.abs(a - t) < 1 * DEG) a = t;
    }
    this.scene.box.angle = Math.max(-45 * DEG, Math.min(45 * DEG, a));
  }
}

function pathPoly(ctx, pts, begin = true) {
  if (begin) ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function label(ctx, text, x, y, px, color, align = 'left') {
  ctx.save();
  ctx.font = `600 ${11 * px}px system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 3 * px;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function handle(ctx, p, r, round) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = round ? '#2563eb' : '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = round ? '#ffffff' : '#2563eb';
  ctx.stroke();
}
