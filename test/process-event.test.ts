import { describe, expect, it } from "vitest";
import {
  processEvent,
  type BreezeClient,
  type BreezeNotification,
  type ProcessedIds,
  type RiderDirectory,
} from "../src/process-event.js";

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

function staticRiderDirectory(ridersByTenant: Record<string, string[]>): RiderDirectory {
  return {
    listRiders: async (tenantId) => ridersByTenant[tenantId] ?? [],
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

    await processEvent(
      bookingConfirmedEvent,
      breeze,
      inMemorySeenIds(),
      staticRiderDirectory({}),
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

  it("delivers a republished event (same transaction) only once", async () => {
    const { breeze, delivered } = recordingBreeze();
    const seen = inMemorySeenIds();

    const riders = staticRiderDirectory({});
    await processEvent(bookingConfirmedEvent, breeze, seen, riders);
    await processEvent({ ...bookingConfirmedEvent, event_id: "evt-1-retry" }, breeze, seen, riders);

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
      staticRiderDirectory({}),
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

  it("fans a service disruption out to every rider of the affected AV Service", async () => {
    const { breeze, delivered } = recordingBreeze();

    await processEvent(
      {
        event_id: "evt-3",
        transaction_id: "txn-2",
        tenant_id: "breeze-av",
        rider_id: null,
        type: "service_disruption",
        occurred_at: "2026-02-06T11:00:00Z",
        data: { reason: "Route 4 suspended" },
      },
      breeze,
      inMemorySeenIds(),
      staticRiderDirectory({ "breeze-av": ["rider-1", "rider-2"] }),
    );

    expect(delivered).toEqual([
      {
        riderId: "rider-1",
        tenantId: "breeze-av",
        title: "Service disruption",
        body: "Route 4 suspended",
      },
      {
        riderId: "rider-2",
        tenantId: "breeze-av",
        title: "Service disruption",
        body: "Route 4 suspended",
      },
    ]);
  });
});
