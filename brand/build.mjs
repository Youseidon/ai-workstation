#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = (path, data) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log("  wrote", path);
};

export const PALETTE = {
  cyan: "#38d9f0",
  violet: "#b39bf8",
  deepCyan: "#0d7287",
  deepViolet: "#6b4bd6",
  abyss: "#12151c",
  trench: "#0b0d10",
  plate: "#1d2230",
  bone: "#e8edf7",
  ink: "#0f1520",
  paper: "#f5f7fb",
};
const AGENTS = ["#f0a97a", "#5ee9a4", "#62b8f5", "#f57fa8", "#b087f0", "#ffd166"];

const FULL = { r0: 6, r1: 15, r2: 23, rh: 22, sweep: 58, bend: 18, neck: 4.6, hx: 5.7, hy: 4.7, push: 1.3, core: 6, eye: 1.2 };
const SMALL = { ...FULL, neck: 5.6, hx: 6.1, hy: 5.6, push: 0.8, rh: 21.5, sweep: 54, core: 6.6 };

const rad = (d) => (d * Math.PI) / 180;
const at = (r, a) => [32 + r * Math.cos(rad(a)), 32 + r * Math.sin(rad(a))];
const n = (v) => +v.toFixed(2);

function geometry(o) {
  const necks = [];
  const heads = [];
  for (let i = 0; i < 6; i++) {
    const a = -90 + i * 60;
    const p0 = at(o.r0, a);
    const c1 = at(o.r1, a + 4);
    const c2 = at(o.r2, a + o.sweep - o.bend);
    const p3 = at(o.rh, a + o.sweep);
    necks.push(`M${n(p0[0])} ${n(p0[1])}C${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(p3[0])} ${n(p3[1])}`);
    const len = Math.hypot(p3[0] - c2[0], p3[1] - c2[1]);
    const ux = (p3[0] - c2[0]) / len;
    const uy = (p3[1] - c2[1]) / len;
    const cx = p3[0] + ux * o.push;
    const cy = p3[1] + uy * o.push;
    heads.push({
      cx: n(cx), cy: n(cy),
      angle: n((Math.atan2(uy, ux) * 180) / Math.PI),
      ex: n(cx + ux * 1.6 + uy * 1.3), ey: n(cy + uy * 1.6 - ux * 1.3),
    });
  }
  const hex = Array.from({ length: 6 }, (_, i) => at(o.core, -60 + i * 60).map(n).join(" "));
  return { necks, heads, core: `M${hex.join("L")}Z`, neck: o.neck, hx: o.hx, hy: o.hy, eye: o.eye };
}

const full = geometry(FULL);
const small = geometry(SMALL);

let ids = 0;
function mark(g, { fill, core, eyes = true, gradient = [PALETTE.cyan, PALETTE.violet], x = 0, y = 0, scale = 1 }) {
  const id = `h${ids++}`;
  const defs = [];
  let paint = (i) => (Array.isArray(fill) ? fill[i] : fill);
  if (fill === "gradient") {
    defs.push(`<linearGradient id="${id}g" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${gradient[0]}"/><stop offset="1" stop-color="${gradient[1]}"/></linearGradient>`);
    paint = () => `url(#${id}g)`;
  }
  if (eyes) {
    defs.push(`<mask id="${id}m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>${g.heads.map((h) => `<circle cx="${h.ex}" cy="${h.ey}" r="${g.eye}" fill="#000"/>`).join("")}</mask>`);
  }
  const body = [
    ...g.necks.map((d, i) => `<path d="${d}" fill="none" stroke="${paint(i)}" stroke-width="${g.neck}" stroke-linecap="round"/>`),
    ...g.heads.map((h, i) => `<ellipse cx="${h.cx}" cy="${h.cy}" rx="${g.hx}" ry="${g.hy}" transform="rotate(${h.angle} ${h.cx} ${h.cy})" fill="${paint(i)}"/>`),
    `<path d="${g.core}" fill="${core ?? paint(0)}"/>`,
  ].join("");
  const transform = x || y || scale !== 1 ? ` transform="translate(${n(x)} ${n(y)}) scale(${n(scale * 1000) / 1000})"` : "";
  return `${defs.length ? `<defs>${defs.join("")}</defs>` : ""}<g${transform}><g${eyes ? ` mask="url(#${id}m)"` : ""}>${body}</g></g>`;
}

const word = JSON.parse(readFileSync(join(here, "source/wordmark.json"), "utf8"));
const WORD_W = word.bbox.x2 - word.bbox.x1;
const WORD_H = word.bbox.y2 - word.bbox.y1;

function wordmark({ fill, x, baseline, scale }) {
  return `<path transform="translate(${n(x - word.bbox.x1 * scale)} ${n(baseline)}) scale(${n(scale * 10000) / 10000})" d="${word.d}" fill="${fill}"/>`;
}

const svg = (w, h, inner, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}"><title>${title}</title>${inner}</svg>\n`;

function horizontal({ markFill, gradient, wordFill }) {
  const s = 0.33;
  const baseline = 32 + (word.xHeight * s) / 2;
  const width = Math.ceil(64 + 12 + WORD_W * s + 2);
  return svg(width, 64, mark(full, { fill: markFill, gradient }) + wordmark({ fill: wordFill, x: 76, baseline, scale: s }), "Hydra");
}

function stacked({ markFill, gradient, wordFill }) {
  const s = 0.3;
  const width = Math.ceil(WORD_W * s + 8);
  const markX = (width - 64) / 2;
  const baseline = 64 + 14 + -word.bbox.y1 * s;
  const height = Math.ceil(baseline + word.bbox.y2 * s + 2);
  return svg(width, height, mark(full, { fill: markFill, gradient, x: markX }) + wordmark({ fill: wordFill, x: (width - WORD_W * s) / 2, baseline, scale: s }), "Hydra");
}

function appIcon({ shape = "rounded", markScale = 0.72, geometry: g = full, eyes = true, bloom = true }) {
  const size = 1024;
  const r = shape === "rounded" ? 230 : 0;
  const ms = (size * markScale) / 64;
  const offset = (size - 64 * ms) / 2;
  const id = `t${ids++}`;
  return svg(size, size, `<defs>
<radialGradient id="${id}p" cx="50%" cy="0%" r="110%"><stop offset="0" stop-color="${PALETTE.plate}"/><stop offset="0.55" stop-color="${PALETTE.abyss}"/><stop offset="1" stop-color="${PALETTE.trench}"/></radialGradient>
<radialGradient id="${id}b" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${PALETTE.cyan}" stop-opacity="0.26"/><stop offset="1" stop-color="${PALETTE.cyan}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${size}" height="${size}" rx="${r}" fill="url(#${id}p)"/>
${r ? `<rect x="3" y="3" width="${size - 6}" height="${size - 6}" rx="${r - 3}" fill="none" stroke="#ffffff" stroke-opacity="0.07" stroke-width="6"/>` : ""}
${bloom ? `<circle cx="512" cy="512" r="${n(size * markScale * 0.62)}" fill="url(#${id}b)"/>` : ""}
${mark(g, { fill: "gradient", eyes, x: offset, y: offset, scale: ms })}`, "Hydra");
}

function faviconTile() {
  return svg(64, 64, `<rect width="64" height="64" rx="14" fill="${PALETTE.abyss}"/>${mark(small, { fill: PALETTE.cyan, eyes: false, x: 4, y: 4, scale: 56 / 64 })}`, "Hydra");
}

function tabIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.m{fill:${PALETTE.deepCyan};stroke:${PALETTE.deepCyan}}@media (prefers-color-scheme:dark){.m{fill:${PALETTE.cyan};stroke:${PALETTE.cyan}}}</style><g class="m">${small.necks.map((d) => `<path d="${d}" fill="none" stroke-width="${small.neck}" stroke-linecap="round"/>`).join("")}${small.heads.map((h) => `<ellipse cx="${h.cx}" cy="${h.cy}" rx="${small.hx}" ry="${small.hy}" transform="rotate(${h.angle} ${h.cx} ${h.cy})" stroke="none"/>`).join("")}<path d="${small.core}" stroke="none"/></g></svg>\n`;
}

function banner() {
  const s = 1.05;
  const markScale = 5.2;
  const markX = 150;
  const markY = 320 - 32 * markScale;
  const wordX = markX + 64 * markScale + 80;
  const baseline = 340;
  return svg(1280, 640, `<defs>
<radialGradient id="bg" cx="28%" cy="40%" r="85%"><stop offset="0" stop-color="${PALETTE.plate}"/><stop offset="0.5" stop-color="${PALETTE.abyss}"/><stop offset="1" stop-color="${PALETTE.trench}"/></radialGradient>
<radialGradient id="bloom" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${PALETTE.cyan}" stop-opacity="0.22"/><stop offset="1" stop-color="${PALETTE.cyan}" stop-opacity="0"/></radialGradient>
<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity="0.035"/></pattern>
</defs>
<rect width="1280" height="640" fill="url(#bg)"/>
<rect width="1280" height="640" fill="url(#grid)"/>
<circle cx="${markX + 32 * markScale}" cy="320" r="260" fill="url(#bloom)"/>
${mark(full, { fill: AGENTS, core: PALETTE.bone, x: markX, y: markY, scale: markScale })}
${wordmark({ fill: PALETTE.bone, x: wordX, baseline, scale: s })}
<text x="${wordX + 4}" y="${baseline + 74}" fill="#a7b2c4" font-family="Geist, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="34" letter-spacing="0.5">Many heads. One console.</text>
<text x="${wordX + 4}" y="${baseline + 118}" fill="#8892a4" font-family="'Geist Mono', ui-monospace, Menlo, monospace" font-size="20" letter-spacing="1">claude · codex · cursor · grok · copilot · kilo</text>`, "Hydra — Many heads. One console.");
}

function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

const png = (svgText, size) => sharp(Buffer.from(svgText), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

console.log("Hydra brand build");

const logo = {
  "hydra-mark.svg": svg(64, 64, mark(full, { fill: "gradient" }), "Hydra"),
  "hydra-mark-daylight.svg": svg(64, 64, mark(full, { fill: "gradient", gradient: [PALETTE.deepCyan, PALETTE.deepViolet] }), "Hydra"),
  "hydra-mark-cyan.svg": svg(64, 64, mark(full, { fill: PALETTE.cyan }), "Hydra"),
  "hydra-mark-spectrum.svg": svg(64, 64, mark(full, { fill: AGENTS, core: PALETTE.bone }), "Hydra"),
  "hydra-mark-bone.svg": svg(64, 64, mark(full, { fill: PALETTE.bone }), "Hydra"),
  "hydra-mark-ink.svg": svg(64, 64, mark(full, { fill: PALETTE.ink }), "Hydra"),
  "hydra-mark-small.svg": svg(64, 64, mark(small, { fill: PALETTE.cyan, eyes: false }), "Hydra"),
  "hydra-wordmark-bone.svg": svg(Math.ceil(WORD_W * 0.36 + 2), Math.ceil(WORD_H * 0.36 + 2), wordmark({ fill: PALETTE.bone, x: 1, baseline: 1 - word.bbox.y1 * 0.36, scale: 0.36 }), "Hydra"),
  "hydra-wordmark-ink.svg": svg(Math.ceil(WORD_W * 0.36 + 2), Math.ceil(WORD_H * 0.36 + 2), wordmark({ fill: PALETTE.ink, x: 1, baseline: 1 - word.bbox.y1 * 0.36, scale: 0.36 }), "Hydra"),
  "hydra-lockup-dark.svg": horizontal({ markFill: "gradient", wordFill: PALETTE.bone }),
  "hydra-lockup-daylight.svg": horizontal({ markFill: "gradient", gradient: [PALETTE.deepCyan, PALETTE.deepViolet], wordFill: PALETTE.ink }),
  "hydra-lockup-stacked-dark.svg": stacked({ markFill: "gradient", wordFill: PALETTE.bone }),
  "hydra-lockup-stacked-daylight.svg": stacked({ markFill: "gradient", gradient: [PALETTE.deepCyan, PALETTE.deepViolet], wordFill: PALETTE.ink }),
  "hydra-app-icon.svg": appIcon({}),
  "hydra-banner.svg": banner(),
};
for (const [name, text] of Object.entries(logo)) out(`brand/logo/${name}`, text);

const tile = appIcon({});
const square = appIcon({ shape: "square", markScale: 0.66 });
const maskable = appIcon({ shape: "square", markScale: 0.54 });
const fav = faviconTile();

for (const size of [64, 128, 256, 512, 1024]) out(`brand/icons/hydra-icon-${size}.png`, await png(tile, size));
out("brand/icons/hydra-apple-touch-180.png", await png(square, 180));
out("brand/icons/hydra-maskable-512.png", await png(maskable, 512));
for (const size of [16, 32, 48]) out(`brand/icons/hydra-favicon-${size}.png`, await png(fav, size));
const favicon = ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(fav, size) }))));
out("brand/icons/favicon.ico", favicon);
out("brand/icons/hydra-banner.png", await sharp(Buffer.from(logo["hydra-banner.svg"])).png({ compressionLevel: 9 }).toBuffer());

out("web/app/favicon.ico", favicon);
out("web/app/icon.svg", tabIcon());
out("web/app/apple-icon.png", await png(square, 180));
out("web/public/brand/hydra-icon-192.png", await png(tile, 192));
out("web/public/brand/hydra-icon-512.png", await png(tile, 512));
out("web/public/brand/hydra-maskable-512.png", await png(maskable, 512));

out("web/components/brand/geometry.ts", `/**
 * Generated by brand/build.mjs — do not edit. Change the parameters there and
 * run \`node brand/build.mjs\`, so the app's inline mark and the logo files stay
 * identical. All coordinates are in a 64×64 box.
 */

export interface HeadGeometry { cx: number; cy: number; angle: number; ex: number; ey: number }
export interface MarkGeometry { necks: readonly string[]; heads: readonly HeadGeometry[]; core: string; neck: number; hx: number; hy: number; eye: number }

export const MARK: MarkGeometry = ${JSON.stringify(full)};

/** Heavier cut for 24 px and below: no eyes, thicker necks. */
export const MARK_SMALL: MarkGeometry = ${JSON.stringify(small)};

/** "hydra" in Unbounded SemiBold, outlined. Baseline at y=0, 100 units per em. */
export const WORDMARK = { d: ${JSON.stringify(word.d)}, x: ${word.bbox.x1}, y: ${word.bbox.y1}, width: ${WORD_W}, height: ${n(WORD_H)} } as const;
`);

const book = join(here, "guidelines.html");
const marker = /\/\* geometry:start[^\n]*\n[\s\S]*?\/\* geometry:end \*\//;
const html = readFileSync(book, "utf8");
if (!marker.test(html)) throw new Error("guidelines.html lost its geometry markers");
out("brand/guidelines.html", html.replace(marker, `/* geometry:start — injected by brand/build.mjs, do not edit */\nconst MARK = ${JSON.stringify(full)};\n/* geometry:end */`));

console.log("done");
