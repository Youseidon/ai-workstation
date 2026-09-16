import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CountUp, countUpDisplayValue } from "./CountUp";

test("CountUp renders negative zero as zero on initial paint", () => {
  assert.equal(renderToStaticMarkup(<CountUp value={-0} />), "0");
});

test("CountUp passes zero, not negative zero, to custom formatters", () => {
  let formattedValue: number | undefined;

  const html = renderToStaticMarkup(
    <CountUp
      value={-0}
      format={(value) => {
        formattedValue = value;
        return `${value} AVAILABLE`;
      }}
    />,
  );

  assert.equal(html, "0 AVAILABLE");
  assert.equal(Object.is(formattedValue, -0), false);
});

test("CountUp preserves meaningful negative values", () => {
  assert.equal(renderToStaticMarkup(<CountUp value={-1} />), "-1");
  assert.equal(countUpDisplayValue(-1), -1);
});

test("CountUp normalizes negative zero produced by rounding", () => {
  assert.equal(Object.is(Math.round(-0.4), -0), true);
  assert.equal(countUpDisplayValue(Math.round(-0.4)), 0);
});
