import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROVIDER_IDS } from "@hydra/shared";
import { MARK, MARK_SMALL } from "../../../components/brand/geometry";

/**
 * The mark has one head per provider and `HydraMark live` lights head i for
 * PROVIDER_IDS[i]. A seventh provider would silently have no head, so adding
 * one must fail here and send someone to brand/build.mjs first.
 */
test("the mark has exactly one head per provider", () => {
  for (const geometry of [MARK, MARK_SMALL]) {
    assert.equal(geometry.heads.length, PROVIDER_IDS.length);
    assert.equal(geometry.necks.length, PROVIDER_IDS.length);
  }
});

test("every head colour the mark paints is a theme token", () => {
  const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");
  for (const provider of PROVIDER_IDS) assert.match(css, new RegExp(`--agent-${provider}:`), provider);
  // The gradient stops are defined for every theme, so the mark never renders black.
  for (const theme of ["midnight", "deep", "daylight"]) {
    const block = css.split(`[data-theme="${theme}"]`)[1]?.split("}")[0] ?? "";
    assert.match(block, /--brand-from:/, theme);
    assert.match(block, /--brand-to:/, theme);
  }
});
