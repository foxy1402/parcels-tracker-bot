import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSnapshot } from "./track123.js";

test("normalizeSnapshot picks tracking record from wrapped response data", () => {
  const raw = {
    code: 200,
    message: "ok",
    data: {
      list: [
        {
          tracking_number: "OTHER123",
          status: "In Transit"
        },
        {
          tracking_number: "SPXVN064584367312",
          status: "Delivered",
          carrier_code: "SPXVN",
          checkpoints: [
            {
              event_time: "2026-01-01T10:00:00Z",
              location: "Ho Chi Minh City",
              description: "Package delivered"
            }
          ]
        }
      ]
    }
  };

  const snapshot = normalizeSnapshot(raw, "SPXVN064584367312");

  assert.equal(snapshot.trackingNumber, "SPXVN064584367312");
  assert.equal(snapshot.status, "Delivered");
  assert.equal(snapshot.carrierCode, "SPXVN");
  assert.equal(snapshot.terminal, true);
  assert.equal(snapshot.lastCheckpoint?.location, "Ho Chi Minh City");
});

test("normalizeSnapshot falls back to explicit carrier when not present in payload", () => {
  const raw = {
    data: [
      {
        tracking_number: "SPXVN064584367312",
        status: "In Transit"
      }
    ]
  };

  const snapshot = normalizeSnapshot(raw, "SPXVN064584367312", "SPXVN");
  assert.equal(snapshot.carrierCode, "SPXVN");
  assert.equal(snapshot.terminal, false);
});

test("normalizeSnapshot supports trackingStatus/transitStatus shape", () => {
  const raw = {
    data: {
      accepted: {
        content: [
          {
            trackNo: "SPXVN064584367312",
            trackingStatus: "001",
            transitStatus: "INIT",
            localLogisticsInfo: {
              courierCode: "shopeeexpressvn"
            }
          }
        ]
      }
    }
  };

  const snapshot = normalizeSnapshot(raw, "SPXVN064584367312");
  assert.equal(snapshot.status, "001");
  assert.equal(snapshot.carrierCode, "shopeeexpressvn");
});
