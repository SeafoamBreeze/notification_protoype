import { describe, expect, it } from "vitest";
import { processEvent, type BreezeClient, type BreezeNotification } from "../src/process-event.js";

function recordingBreeze(): { breeze: BreezeClient; delivered: BreezeNotification[] } {
  const delivered: BreezeNotification[] = [];
  return {
    delivered,
    breeze: {
      deliver: async (notification) => {
        delivered.push(notification);
      },
    },
  };
}

describe("processEvent", () => {
  it("delivers a booking confirmation to the booking's rider", async () => {
    const { breeze, delivered } = recordingBreeze();

    await processEvent(
      {
        event_id: "evt-1",
        transaction_id: "txn-1",
        tenant_id: "breeze-av",
        rider_id: "rider-1",
        type: "booking_confirmed",
        occurred_at: "2026-02-06T10:00:00Z",
        data: { booking_ref: "B-123" },
      },
      breeze,
    );

    expect(delivered).toEqual([
      {
        riderId: "rider-1",
        tenantId: "breeze-av",
        title: "Booking confirmed",
        body: "Your AV booking B-123 is confirmed.",
      },
    ]);
  });
});
