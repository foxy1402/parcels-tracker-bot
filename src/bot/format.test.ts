import test from "node:test";
import assert from "node:assert/strict";
import { formatSnapshot, humanizeStatus } from "./format.js";

test("humanizeStatus maps known numeric code", () => {
  assert.equal(humanizeStatus("001"), "Shipment information received (001)");
});

test("humanizeStatus maps known transit keyword", () => {
  assert.equal(humanizeStatus("DELIVERED"), "Delivered");
});

test("formatSnapshot includes human-readable status", () => {
  const text = formatSnapshot({
    trackingNumber: "SPXVN064584367312",
    carrierCode: "shopeeexpressvn",
    status: "001",
    terminal: false
  });

  assert.equal(text.includes("Status: Shipment information received (001)"), true);
});
