import { describe, expect, it } from "vitest";
import {
  processEvent,
  type BreezeClient,
  type BreezeNotification,
  type ProcessedIds,
  type RiderDirectory,
} from "../src/process-event.js";
import { defaultTenantConfigStore } from "../src/tenant-config.js";

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
      defaultTenantConfigStore(),
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
    await processEvent(bookingConfirmedEvent, breeze, seen, riders, defaultTenantConfigStore());
    await processEvent(
      { ...bookingConfirmedEvent, event_id: "evt-1-retry" },
      breeze,
      seen,
      riders,
      defaultTenantConfigStore(),
    );

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
      defaultTenantConfigStore(),
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
      defaultTenantConfigStore(),
    );

    // Fan-out is concurrent, so delivery order is not guaranteed.
    expect(delivered.sort((a, b) => a.riderId.localeCompare(b.riderId))).toEqual([
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

  it("does not mark a transaction processed when delivery fails", async () => {
    let attempts = 0;
    const breeze: BreezeClient = {
      deliver: async () => {
        attempts++;
        if (attempts === 1) throw new Error("breeze down");
      },
    };
    const seen = inMemorySeenIds();
    const riders = staticRiderDirectory({});
    const store = defaultTenantConfigStore();

    await expect(processEvent(bookingConfirmedEvent, breeze, seen, riders, store)).rejects.toThrow(
      "breeze down",
    );

    await processEvent(bookingConfirmedEvent, breeze, seen, riders, store);

    expect(attempts).toBe(2);
  });

  it("bounds the number of in-flight deliveries during a large fan-out", async () => {
    const riderIds = Array.from({ length: 25 }, (_, i) => `rider-${i + 1}`);
    let inFlight = 0;
    let peakInFlight = 0;
    const delivered: BreezeNotification[] = [];
    const breeze: BreezeClient = {
      deliver: async (notification) => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        delivered.push(notification);
      },
    };

    await processEvent(
      {
        event_id: "evt-4",
        transaction_id: "txn-3",
        tenant_id: "breeze-av",
        rider_id: null,
        type: "service_disruption",
        occurred_at: "2026-02-06T11:00:00Z",
        data: { reason: "Fleet maintenance" },
      },
      breeze,
      inMemorySeenIds(),
      staticRiderDirectory({ "breeze-av": riderIds }),
      defaultTenantConfigStore(),
      { maxConcurrentDeliveries: 10 },
    );

    expect(delivered).toHaveLength(25);
    expect(peakInFlight).toBeLessThanOrEqual(10);
    expect(new Set(delivered.map((n) => n.riderId))).toEqual(new Set(riderIds));
  });
});
