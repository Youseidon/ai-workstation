#!/usr/bin/env node
// Runs one or more scenarios repeatedly; any failure fails the burn-in
// (docs/e2e-harness-plan.md section 3, principle 6). Usage:
//   npm run e2e:burn-in -- --project=t1 --repeat=3 tests/t1/some.spec.ts -g "H-L1-06"
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const repeat = Number(args.find((arg) => arg.startsWith("--repeat="))?.split("=")[1] ?? 3);
const rest = args.filter((arg) => !arg.startsWith("--repeat="));
if (!rest.some((arg) => arg.startsWith("--project=") || arg === "--config")) rest.unshift("--project=t1");
if (!Number.isInteger(repeat) || repeat < 1) {
  console.error("--repeat must be a positive integer");
  process.exit(2);
}
const result = spawnSync("npx", ["playwright", "test", `--repeat-each=${repeat}`, "--max-failures=1", ...rest], { stdio: "inherit" });
process.exit(result.status ?? 1);
