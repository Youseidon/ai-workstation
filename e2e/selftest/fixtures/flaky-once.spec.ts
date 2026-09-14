import { appendFileSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Fails on exactly one iteration, chosen by SELFTEST_FLAKY_ITERATION.
test("flaky once", () => {
  const counter = process.env.SELFTEST_COUNTER_FILE!;
  appendFileSync(counter, "x");
  const iteration = readFileSync(counter, "utf8").length;
  expect(iteration).not.toBe(Number(process.env.SELFTEST_FLAKY_ITERATION ?? "0"));
});
