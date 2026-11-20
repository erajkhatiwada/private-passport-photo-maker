// Face geometry, crop suggestion and compliance checks.
// A crop box is { cx, cy, w, h, angle } in source-image pixels; `angle` (radians) is the
// rotation of the box's x-axis, so rendering the box upright levels a tilted head.

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const DEG = 180 / Math.PI;

export const axes = (angle) => ({
  e1: { x: Math.cos(angle), y: Math.sin(angle) }, // box "right"
  e2: { x: -Math.sin(angle), y: Math.cos(angle) }, // box "down"
});

// Typical crown height above the top face landmark, as a fraction of forehead→chin.
// Used only when the segmentation mask can't locate the top of the head.
const CROWN_ESTIMATE = 0.3;

export function analyzeFace(face, W, H) {
  const lm = face.landmarks;
  const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
  const hasIris = lm.length > 473;
  const a = hasIris ? P(468) : mid(P(33), P(133));
  const b = hasIris ? P(473) : mid(P(362), P(263));
  const [eyeL, eyeR] = a.x <= b.x ? [a, b] : [b, a]; // image-left, image-right
  const theta = Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x);
  const { e1, e2 } = axes(theta);
  const chin = P(152);
  const forehead = P(10);
  const cheekA = P(234);
  const cheekB = P(454);
  const bs = face.blendshapes || {};
  return {
    eyeL,
    eyeR,
    eyeMid: mid(eyeL, eyeR),
    chin,
    forehead,
    center: mid(cheekA, cheekB),
    theta,
    e1,
    e2,
    faceW: Math.abs(dot(sub(cheekB, cheekA), e1)),
    faceH: dot(sub(chin, forehead), e2),
    pose: poseFromMatrix(face.matrix),
    blink: Math.max(bs.eyeBlinkLeft ?? 0, bs.eyeBlinkRight ?? 0),
    smile: Math.max(bs.mouthSmileLeft ?? 0, bs.mouthSmileRight ?? 0),
    jawOpen: bs.jawOpen ?? 0,
  };
}

// MediaPipe's facial transformation matrix is a column-major 4×4.
function poseFromMatrix(m) {
  if (!m || m.length < 16) return null;
  const r = (i, j) => m[j * 4 + i];
  return {
    pitch: Math.atan2(r(2, 1), r(2, 2)) * DEG,
    yaw: Math.asin(Math.max(-1, Math.min(1, -r(2, 0)))) * DEG,
    roll: Math.atan2(r(1, 0), r(0, 0)) * DEG,
  };
}

// Region (source px) worth segmenting around a face: head plus shoulders.
export function faceRegion(face, W, H) {
  const s = face.faceH;
  return clipRect(
    {
      x: face.center.x - 2.3 * s,
      y: face.forehead.y - 1.7 * s,
      w: 4.6 * s,
      h: 5.2 * s,
    },
    W,
    H
  );
}

export function clipRect(r, W, H) {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(W, Math.ceil(r.x + r.w));
  const y2 = Math.min(H, Math.ceil(r.y + r.h));
  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

// Walk upward from the top of the face through the person mask to find the top of the head.
export function findCrown(face, matte, W, H) {
  const up = mul(face.e2, -1);
  const fallback = {
    point: add(face.forehead, mul(up, face.faceH * CROWN_ESTIMATE)),
    estimated: true,
    touchesEdge: false,
  };
  if (!matte) return fallback;

  const step = 1 / matte.scale;
  const maxT = face.faceH;
  const maxGap = face.faceH * 0.04;
  let best = 0;
  let touchesEdge = false;
  for (const o of [-0.2, -0.1, 0, 0.1, 0.2]) {
    const start = add(face.forehead, mul(face.e1, o * face.faceW));
    let last = 0;
    let gap = 0;
    for (let t = 0; t <= maxT; t += step) {
      const p = add(start, mul(up, t));
      if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) {
        if (gap === 0) touchesEdge = true;
        break;
      }
      const a = sampleAlpha(matte, p.x, p.y);
      if (a === null) break;
      if (a >= 0.5) {
        last = t;
        gap = 0;
      } else if ((gap += step) > maxGap) {
        break;
      }
    }
    best = Math.max(best, last);
  }
  if (best < face.faceH * 0.05) return fallback;
  best = Math.min(best, face.faceH * 0.9);
  return { point: add(face.forehead, mul(up, best)), estimated: false, touchesEdge };
}

function sampleAlpha(matte, x, y) {
  const mx = Math.round((x - matte.region.x) * matte.scale);
  const my = Math.round((y - matte.region.y) * matte.scale);
  if (mx < 0 || my < 0 || mx >= matte.width || my >= matte.height) return null;
  return matte.alpha[my * matte.width + mx];
}

// Where the head should sit inside the photo, in mm from the top edge.
export function headTarget(face, crown, spec) {
  const headMm = (spec.head[0] + spec.head[1]) / 2;
  let crownY;
  if (spec.eyeFromBottom) {
    const eyeY = spec.h - (spec.eyeFromBottom[0] + spec.eyeFromBottom[1]) / 2;
    const headPx = dot(sub(face.chin, crown), face.e2);
    const eyeRatio = headPx > 0 ? dot(sub(face.eyeMid, crown), face.e2) / headPx : 0.45;
    crownY = eyeY - eyeRatio * headMm;
  } else if (spec.topMargin != null) {
    crownY = spec.topMargin;
  } else {
    crownY = (spec.h - headMm) * 0.4;
  }
  return { crownY, chinY: crownY + headMm, headMm };
}

export function suggestBox(face, crown, spec) {
  const { e1, e2 } = face;
  const headPx = dot(sub(face.chin, crown), e2);
  const target = headTarget(face, crown, spec);
  const ppm = headPx / target.headMm; // source pixels per millimetre
  const w = spec.w * ppm;
  const h = spec.h * ppm;
  // Face centre horizontally; crown at its target height.
  const u = dot(face.center, e1);
  const v = dot(crown, e2) - (target.crownY * ppm - h / 2);
  return { cx: u * e1.x + v * e2.x, cy: u * e1.y + v * e2.y, w, h, angle: face.theta };
}

// Fallback when no face is found: the largest centred box that fits the photo.
export function defaultBox(W, H, spec) {
  const aspect = spec.w / spec.h;
  let h = H * 0.9;
  let w = h * aspect;
  if (w > W * 0.9) {
    w = W * 0.9;
    h = w / aspect;
  }
  return { cx: W / 2, cy: H / 2, w, h, angle: 0 };
}

// Positions of facial features inside the crop, in mm from the photo's top-left.
export function measure(face, crown, box, spec) {
  const ppm = box.w / spec.w;
  const { e1, e2 } = axes(box.angle);
  const c = { x: box.cx, y: box.cy };
  const local = (p) => {
    const d = sub(p, c);
    return { x: dot(d, e1) / ppm + spec.w / 2, y: dot(d, e2) / ppm + spec.h / 2 };
  };
  const crownL = local(crown);
  const chinL = local(face.chin);
  const eyeL = local(face.eyeMid);
  const centerL = local(face.center);
  return {
    headMm: chinL.y - crownL.y,
    crownMm: crownL.y,
    chinMm: chinL.y,
    eyeFromBottomMm: spec.h - eyeL.y,
    centerOffsetMm: centerL.x - spec.w / 2,
    tiltDeg: (face.theta - box.angle) * DEG,
  };
}

export function boxCorners(box) {
  const { e1, e2 } = axes(box.angle);
  const hw = box.w / 2;
  const hh = box.h / 2;
  return [
    [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh],
  ].map(([u, v]) => ({ x: box.cx + e1.x * u + e2.x * v, y: box.cy + e1.y * u + e2.y * v }));
}

export function boxBounds(box) {
  const pts = boxCorners(box);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function fmtLen(mm, spec) {
  return spec.units === 'in' ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
}

// Returns [{ status: 'pass'|'warn'|'fail'|'info', label, detail }]
export function runChecks({ face, faceCount, crown, box, spec, W, H, outW, bgMode }) {
  const out = [];
  const push = (status, label, detail = '') => out.push({ status, label, detail });

  if (!face) {
    push('fail', 'No face detected', 'Try a sharper, front-facing photo — or position the box by hand.');
  } else {
    if (faceCount > 1) push('warn', `${faceCount} faces found`, 'Using the largest. The photo must show only you.');
    const m = measure(face, crown.point, box, spec);
    const [hMin, hMax] = spec.head;
    const tol = 0.2;
    push(
      m.headMm >= hMin - tol && m.headMm <= hMax + tol ? 'pass' : 'fail',
      `Head size ${fmtLen(m.headMm, spec)}`,
      `Chin to top of head must be ${fmtLen(hMin, spec)} – ${fmtLen(hMax, spec)}.`
    );
    if (spec.eyeFromBottom) {
      const [eMin, eMax] = spec.eyeFromBottom;
      push(
        m.eyeFromBottomMm >= eMin - tol && m.eyeFromBottomMm <= eMax + tol ? 'pass' : 'fail',
        `Eye height ${fmtLen(m.eyeFromBottomMm, spec)}`,
        `Eyes must be ${fmtLen(eMin, spec)} – ${fmtLen(eMax, spec)} from the bottom.`
      );
    }
    if (m.crownMm < 0.5 || m.chinMm > spec.h - 0.5) {
      push('fail', 'Head is cut off', 'The whole head, from chin to the top of the hair, must be inside the photo.');
    }
    if (Math.abs(m.centerOffsetMm) > spec.w * 0.05) {
      push('warn', 'Face is off-centre', 'Centre the face horizontally.');
    }
    if (Math.abs(m.tiltDeg) > 2) {
      push('warn', `Head tilted ${Math.abs(m.tiltDeg).toFixed(1)}°`, 'Rotate the box so the eyes are level.');
    } else {
      push('pass', 'Head is level');
    }
    if (face.pose) {
      const yaw = Math.abs(face.pose.yaw);
      const pitch = Math.abs(face.pose.pitch);
      if (yaw > 8 || pitch > 12) push('warn', 'Not facing the camera', 'Look straight at the camera with your head upright.');
      else push('pass', 'Facing the camera');
    }
    if (face.blink > 0.55) push('fail', 'Eyes may be closed', 'Eyes must be open and clearly visible.');
    else push('pass', 'Eyes open');
    if (face.smile > 0.45 || face.jawOpen > 0.2) {
      push('warn', 'Not a neutral expression', 'Most countries require a neutral face with the mouth closed.');
    } else {
      push('pass', 'Neutral expression');
    }
    if (crown.estimated) {
      push('info', 'Top of head estimated', 'Check the head fits the oval guide; hair and hats can confuse the AI.');
    } else if (crown.touchesEdge) {
      push('warn', 'Top of head touches the photo edge', 'Use a photo with space above your head.');
    }
  }

  const scale = box.w / outW;
  if (scale < 0.75) {
    push('warn', 'Low resolution', `Only ${Math.round(box.w)} px across — it will be upscaled. Use a closer or sharper photo, or 300 DPI.`);
  } else {
    push('pass', 'Sharp enough');
  }

  const outside = boxCorners(box).some((p) => p.x < -1 || p.y < -1 || p.x > W + 1 || p.y > H + 1);
  if (outside) {
    push(
      'warn',
      'Crop goes past the photo edge',
      bgMode === 'color' ? 'The gap is filled with the background colour.' : 'The gap is filled with white. Replacing the background hides it.'
    );
  }
  if (bgMode === 'color') push('pass', 'Background replaced');
  else push('info', 'Original background', 'It must be plain and light. Use “Replace” for a clean, even colour.');

  return out;
}
