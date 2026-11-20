// Photo specifications. All sizes are in millimetres.
//   flag          – emoji shown before the label in the document picker
//   head          – allowed chin-to-crown (top of head) height range
//   eyeFromBottom – allowed eye-line height measured from the bottom edge (only where the rule defines one)
//   topMargin     – fixed gap above the head (only where the rule defines one)
// These are common published values; users should always check their official guidance.
export const PRESETS = [
  {
    id: 'us',
    flag: '🇺🇸',
    label: 'United States — passport / visa',
    size: '2 × 2 in',
    w: 50.8,
    h: 50.8,
    head: [25.4, 34.9],
    eyeFromBottom: [28.6, 34.9],
    units: 'in',
    bg: '#ffffff',
    note: '51 × 51 mm. Head 1–1⅜ in, eyes 1⅛–1⅜ in from the bottom. Plain white or off-white background.',
  },
  {
    id: 'uk',
    flag: '🇬🇧',
    label: 'United Kingdom — passport',
    size: '35 × 45 mm',
    w: 35,
    h: 45,
    head: [29, 34],
    bg: '#e8e8e8',
    note: 'Head 29–34 mm. Plain light grey or cream background. Online applications need at least 600 × 750 px (use 600 DPI).',
  },
  {
    id: 'icao',
    flag: '🇪🇺',
    label: 'Schengen / EU, Australia & most countries',
    size: '35 × 45 mm',
    w: 35,
    h: 45,
    head: [32, 36],
    bg: '#f2f2f2',
    note: 'ICAO standard: head 32–36 mm. Plain light background (white or light grey — check your country).',
  },
  {
    id: 'ca',
    flag: '🇨🇦',
    label: 'Canada — passport',
    size: '50 × 70 mm',
    w: 50,
    h: 70,
    head: [31, 36],
    bg: '#ffffff',
    note: 'Head 31–36 mm. Plain white or light-coloured background.',
  },
  {
    id: 'cn',
    flag: '🇨🇳',
    label: 'China — passport / visa',
    size: '33 × 48 mm',
    w: 33,
    h: 48,
    head: [28, 33],
    topMargin: 4,
    bg: '#ffffff',
    note: 'Head 28–33 mm, 3–5 mm space above the head. White background.',
  },
  {
    id: 'custom',
    flag: '📐',
    label: 'Custom size…',
    custom: true,
    w: 35,
    h: 45,
    bg: '#ffffff',
    note: 'Head is sized to 70–80% of the photo height.',
  },
];

export function resolvePreset(id, custom) {
  const p = PRESETS.find((x) => x.id === id) || PRESETS[0];
  if (!p.custom) return p;
  const w = clampNum(custom?.w, 10, 200, p.w);
  const h = clampNum(custom?.h, 10, 200, p.h);
  return { ...p, w, h, size: `${w} × ${h} mm`, head: [h * 0.7, h * 0.8] };
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Print sheets, landscape orientation (mm). The layout also tries portrait.
export const SHEETS = {
  '4x6': { label: '4 × 6 in (10 × 15 cm) photo print', w: 152.4, h: 101.6 },
  '5x7': { label: '5 × 7 in photo print', w: 177.8, h: 127 },
  a4: { label: 'A4 paper', w: 297, h: 210 },
  letter: { label: 'US Letter paper', w: 279.4, h: 215.9 },
};
