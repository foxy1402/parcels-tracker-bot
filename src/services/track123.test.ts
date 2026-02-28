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
  assert.equal(snapshot.status, "Package delivered");
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

test("normalizeSnapshot prefers latest tracking event detail as status text", () => {
  const raw = {
    data: {
      accepted: {
        content: [
          {
            trackNo: "SPXVN064584367312",
            trackingStatus: "001",
            transitStatus: "IN_TRANSIT",
            localLogisticsInfo: {
              courierCode: "shopeeexpressvn",
              trackingDetails: [
                {
                  eventTime: "2026-02-26 01:50:28",
                  eventDetail: "Người gửi đang chuẩn bị hàng",
                  address: ""
                },
                {
                  eventTime: "2026-02-26 01:40:00",
                  eventDetail: "SLSTN đã được tạo, đang gửi yêu cầu đến đối tác vận chuyển",
                  address: ""
                }
              ]
            }
          }
        ]
      }
    }
  };

  const snapshot = normalizeSnapshot(raw, "SPXVN064584367312");
  assert.equal(snapshot.status, "Người gửi đang chuẩn bị hàng");
  assert.equal(snapshot.lastCheckpoint?.description, "Người gửi đang chuẩn bị hàng");
});

test("normalizeSnapshot marks Vietnamese delivered message as terminal", () => {
  const raw = {
    data: {
      accepted: {
        content: [
          {
            trackNo: "SPXVN064584367312",
            trackingStatus: "001",
            transitStatus: "ABNORMAL",
            transitSubStatus: "ABNORMAL_07",
            localLogisticsInfo: {
              courierCode: "shopeeexpressvn",
              trackingDetails: [
                {
                  eventTime: "2026-02-27 12:35:33",
                  eventDetail: "Giao hàng thành công",
                  transitSubStatus: "DELIVERY_FAILED_04"
                }
              ]
            }
          }
        ]
      }
    }
  };

  const snapshot = normalizeSnapshot(raw, "SPXVN064584367312");
  assert.equal(snapshot.terminal, true);
});

test("normalizeSnapshot marks returning-to-sender substatus as terminal", () => {
  const raw = {
    data: {
      accepted: {
        content: [
          {
            trackNo: "SPXVN064584367312",
            trackingStatus: "001",
            transitStatus: "EXCEPTION",
            transitSubStatus: "RETURNING_TO_SENDER",
            localLogisticsInfo: {
              courierCode: "shopeeexpressvn",
              trackingDetails: [
                {
                  eventTime: "2026-02-27 12:35:33",
                  eventDetail: "Returning to sender",
                  transitSubStatus: "RETURNING_TO_SENDER"
                }
              ]
            }
          }
        ]
      }
    }
  };

  const snapshot = normalizeSnapshot(raw, "SPXVN064584367312");
  assert.equal(snapshot.terminal, true);
});
