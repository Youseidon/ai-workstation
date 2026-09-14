import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/*
 * Reads scenario IDs from the scenario tables (docs/e2e-harness-plan.md 12.2): docs/e2e-scenarios/*.md and
 * any docs/**\/scenarios/*.md, the same files the coverage matrix reads.
 */

const DOCS = resolve(import.meta.dirname, "../../docs");

function tableFiles(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tableFiles(path);
    return path.endsWith(".md") && (path.includes("/e2e-scenarios/") || path.includes("/scenarios/")) ? [path] : [];
  });
}

/** IDs of rows whose tier runs on real Telegram (T3 real), in file and table order. */
export function t3Rows(docs = DOCS): string[] {
  const rows: string[] = [];
  for (const file of tableFiles(docs)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const cells = line.split("|").map((cell) => cell.trim());
      if (!/^S-[A-Z0-9]+-\d+$/.test(cells[1] ?? "")) continue;
      if (cells.some((cell) => /\bT3\b/.test(cell) && /\breal\b/.test(cell))) rows.push(cells[1]!);
    }
  }
  return rows;
}
