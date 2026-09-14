import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Token sweep (docs/e2e-harness-plan.md section 3, principle 8): no secret the
 * harness knows about may appear in any log, artifact, API response capture or
 * database copy. Matches are reported by location and offset, never by value.
 */

export interface SweepFinding {
  file: string;
  entry?: string;
  offset: number;
  secretLabel: string;
}

export interface Secret {
  label: string;
  value: string;
}

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
}

function scanBuffer(buffer: Buffer, secrets: Secret[], file: string, entry?: string): SweepFinding[] {
  const findings: SweepFinding[] = [];
  for (const secret of secrets) {
    const offset = buffer.indexOf(secret.value);
    if (offset >= 0) findings.push({ file, ...(entry === undefined ? {} : { entry }), offset, secretLabel: secret.label });
  }
  return findings;
}

/** Scans files and directories; zip archives (Playwright traces) are scanned entry by entry. */
export function sweep(paths: string[], secrets: Secret[]): SweepFinding[] {
  const usable = secrets.filter((secret) => secret.value.length >= 8);
  if (usable.length === 0) return [];
  const findings: SweepFinding[] = [];
  for (const file of paths.flatMap(walk)) {
    const buffer = readFileSync(file);
    if (file.endsWith(".zip")) {
      const list = spawnSync("unzip", ["-Z1", file], { encoding: "utf8" });
      if (list.status !== 0) throw new Error(`token sweep cannot list ${file}`);
      for (const entry of list.stdout.split("\n").filter(Boolean)) {
        const content = spawnSync("unzip", ["-p", file, entry], { maxBuffer: 512 * 1024 * 1024 });
        findings.push(...scanBuffer(content.stdout, usable, file, entry));
      }
    } else {
      findings.push(...scanBuffer(buffer, usable, file));
    }
  }
  return findings;
}

export function describeFindings(findings: SweepFinding[]): string {
  return findings.map((finding) => `${finding.secretLabel} found in ${finding.file}${finding.entry ? `!${finding.entry}` : ""} at offset ${finding.offset}`).join("\n");
}
