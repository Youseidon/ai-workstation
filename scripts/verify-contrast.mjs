import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../web/app/globals.css", import.meta.url), "utf8");
const themes = [
  ["midnight", css.match(/:root,[\s\S]*?\{([\s\S]*?)\n\}/)?.[1]],
  ["deep", css.match(/\[data-theme="deep"\][\s\S]*?\{([\s\S]*?)\n\}/)?.[1]],
  ["daylight", css.match(/\[data-theme="daylight"\][\s\S]*?\{([\s\S]*?)\n\}/)?.[1]],
];
const foregrounds = [
  "fg", "fg-muted", "fg-dim", "accent", "success", "warning", "caution",
  "danger", "info", "violet", "agent-claude", "agent-codex", "agent-cursor", "agent-grok",
  "agent-copilot",
];
const surfaces = ["surface-0", "surface-1", "surface-2", "surface-3"];

function tokens(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1], match[2]]));
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

let failures = 0;
for (const [theme, block] of themes) {
  if (!block) throw new Error(`Could not find ${theme} theme`);
  const values = tokens(block);
  let minimum = { ratio: Infinity, pair: "" };
  for (const foreground of foregrounds) {
    for (const surface of surfaces) {
      const ratio = contrast(values[foreground], values[surface]);
      if (ratio < minimum.ratio) minimum = { ratio, pair: `${foreground} on ${surface}` };
      if (ratio < 4.5) {
        failures += 1;
        console.error(`FAIL ${theme}: ${foreground} on ${surface} = ${ratio.toFixed(2)}:1`);
      }
    }
  }
  console.log(`PASS ${theme}: minimum ${minimum.ratio.toFixed(2)}:1 (${minimum.pair})`);
}

if (failures > 0) {
  console.error(`${failures} foreground/surface combinations miss WCAG AA (4.5:1).`);
  process.exitCode = 1;
}
