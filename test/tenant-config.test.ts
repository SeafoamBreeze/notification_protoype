import { describe, expect, it } from "vitest";
import {
  InMemoryTenantConfigStore,
  defaultTenantConfigStore,
  type TenantConfig,
  type TenantConfigStore,
} from "../src/tenant-config.js";
import {
  processEvent,
  type BreezeClient,
  type BreezeNotification,
  type ProcessedIds,
  type RiderDirectory,
} from "../src/process-event.js";
import type { DomainEvent } from "../src/events.js";

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

const bookingEvent: DomainEvent = {
  event_id: "evt-t1",
  transaction_id: "txn-t1",
  tenant_id: "tenant-a",
  rider_id: "rider-1",
  type: "booking_confirmed",
  occurred_at: "2026-02-06T10:00:00Z",
  data: { booking_ref: "B-100" },
};

describe("tenant configuration", () => {
  it("does not deliver an event type that is disabled for the tenant", async () => {
    const { breeze, delivered } = recordingBreeze();
    const store: TenantConfigStore = new InMemoryTenantConfigStore({
      "tenant-a": {
        enabledEventTypes: ["arrival_warning"],
        templates: {},
      },
    });

    await processEvent(bookingEvent, breeze, inMemorySeenIds(), staticRiderDirectory({}), store);

    expect(delivered).toHaveLength(0);
  });

  it("uses the tenant's custom template for the notification wording", async () => {
    const { breeze, delivered } = recordingBreeze();
    const config: TenantConfig = {
      enabledEventTypes: ["booking_confirmed", "arrival_warning", "service_disruption"],
      templates: {
        booking_confirmed: (event) => ({
          title: "Körning bekräftad",
          body: `Bekräftelse för ${event.data.booking_ref} (tenant-a).`,
        }),
      },
    };

    await processEvent(
      bookingEvent,
      breeze,
      inMemorySeenIds(),
      staticRiderDirectory({}),
      new InMemoryTenantConfigStore({ "tenant-a": config }),
    );

    expect(delivered).toEqual([
      {
        riderId: "rider-1",
        tenantId: "tenant-a",
        title: "Körning bekräftad",
        body: "Bekräftelse för B-100 (tenant-a).",
      },
    ]);
  });

  it("falls back to the default templates when the tenant has no configuration", async () => {
    const { breeze, delivered } = recordingBreeze();

    await processEvent(
      bookingEvent,
      breeze,
      inMemorySeenIds(),
      staticRiderDirectory({}),
      defaultTenantConfigStore(),
    );

    expect(delivered).toEqual([
      {
        riderId: "rider-1",
        tenantId: "tenant-a",
        title: "Booking confirmed",
        body: "Your AV booking B-100 is confirmed.",
      },
    ]);
  });

  it("uses the tenant's custom template for fan-out (service disruption)", async () => {
    const { breeze, delivered } = recordingBreeze();
    const config: TenantConfig = {
      enabledEventTypes: ["service_disruption"],
      templates: {
        service_disruption: (event) => ({
          title: "Störning",
          body: `tenant-a: ${event.data.reason}`,
        }),
      },
    };

    await processEvent(
      {
        event_id: "evt-t2",
        transaction_id: "txn-t2",
        tenant_id: "tenant-a",
        rider_id: null,
        type: "service_disruption",
        occurred_at: "2026-02-06T11:00:00Z",
        data: { reason: "Route 4 suspended" },
      },
      breeze,
      inMemorySeenIds(),
      staticRiderDirectory({ "tenant-a": ["rider-1", "rider-2"] }),
      new InMemoryTenantConfigStore({ "tenant-a": config }),
    );

    expect(delivered.sort((a, b) => a.riderId.localeCompare(b.riderId))).toEqual([
      { riderId: "rider-1", tenantId: "tenant-a", title: "Störning", body: "tenant-a: Route 4 suspended" },
      { riderId: "rider-2", tenantId: "tenant-a", title: "Störning", body: "tenant-a: Route 4 suspended" },
    ]);
  });
});
