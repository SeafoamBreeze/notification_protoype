import { describe, expect, it } from "vitest";
import { processEvent, type BreezeClient, type BreezeNotification, type ProcessedIds } from "../src/process-event.js";

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

function inMemorySeenIds(): ProcessedIds {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    add: (id) => {
      ids.add(id);
    },
  };
}

const bookingConfirmedEvent = {
  event_id: "evt-1",
  transaction_id: "txn-1",
  tenant_id: "breeze-av",
  rider_id: "rider-1",
  type: "booking_confirmed" as const,
  occurred_at: "2026-02-06T10:00:00Z",
  data: { booking_ref: "B-123" },
};

describe("processEvent", () => {
  it("delivers a booking confirmation to the booking's rider", async () => {
    const { breeze, delivered } = recordingBreeze();

    await processEvent(bookingConfirmedEvent, breeze, inMemorySeenIds());

    expect(delivered).toEqual([
      {
        riderId: "rider-1",
        tenantId: "breeze-av",
        title: "Booking confirmed",
        body: "Your AV booking B-123 is confirmed.",
      },
    ]);
  });

  it("delivers a republished event (same transaction) only once", async () => {
    const { breeze, delivered } = recordingBreeze();
    const seen = inMemorySeenIds();

    await processEvent(bookingConfirmedEvent, breeze, seen);
    await processEvent({ ...bookingConfirmedEvent, event_id: "evt-1-retry" }, breeze, seen);

    expect(delivered).toHaveLength(1);
  });

  it("delivers an arrival warning to the rider when the vehicle is 10 minutes out", async () => {
    const { breeze, delivered } = recordingBreeze();

    await processEvent(
      {
        event_id: "evt-2",
        transaction_id: "txn-1",
        tenant_id: "breeze-av",
        rider_id: "rider-1",
        type: "arrival_warning",
        occurred_at: "2026-02-06T10:50:00Z",
        data: { booking_ref: "B-123", eta_minutes: 10 },
      },
      breeze,
      inMemorySeenIds(),
    );

    expect(delivered).toEqual([
      {
        riderId: "rider-1",
        tenantId: "breeze-av",
        title: "Your AV is arriving",
        body: "Your vehicle for booking B-123 is 10 minutes away.",
      },
    ]);
  });
});
