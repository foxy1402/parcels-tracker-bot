import test from "node:test";
import assert from "node:assert/strict";
import { parseTrackArgs } from "./command-args.js";

test("parseTrackArgs supports plain label with UTF-8", () => {
  const parsed = parseTrackArgs("/track SPXVN064584367312 áo cho mập");
  assert.equal(parsed.trackingNumber, "SPXVN064584367312");
  assert.equal(parsed.carrierCode, undefined);
  assert.equal(parsed.label, "áo cho mập");
});

test("parseTrackArgs supports explicit carrier prefix and UTF-8 label", () => {
  const parsed = parseTrackArgs("/track SPXVN064584367312 carrier:SPXVN áo cho mập");
  assert.equal(parsed.trackingNumber, "SPXVN064584367312");
  assert.equal(parsed.carrierCode, "SPXVN");
  assert.equal(parsed.label, "áo cho mập");
});

test("parseTrackArgs supports backward compatible carrier + label tokens", () => {
  const parsed = parseTrackArgs("/track SPXVN064584367312 SPXVN áo cho mập");
  assert.equal(parsed.trackingNumber, "SPXVN064584367312");
  assert.equal(parsed.carrierCode, "SPXVN");
  assert.equal(parsed.label, "áo cho mập");
});

test("parseTrackArgs single token defaults to label to avoid ambiguity", () => {
  const parsed = parseTrackArgs("/track SPXVN064584367312 SPXVN");
  assert.equal(parsed.trackingNumber, "SPXVN064584367312");
  assert.equal(parsed.carrierCode, undefined);
  assert.equal(parsed.label, "SPXVN");
});
