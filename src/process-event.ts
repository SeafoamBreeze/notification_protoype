import type { DomainEvent } from "./events.js";

/** A notification to be shown to a rider in the Breeze app. */
export interface BreezeNotification {
  riderId: string;
  tenantId: string;
  title: string;
  body: string;
}

/**
 * Delivery boundary to Breeze (a system boundary: mocked in tests and the
 * prototype, real HTTP adapter when the Breeze API spec arrives).
 */
export interface BreezeClient {
  deliver(notification: BreezeNotification): Promise<void>;
}

/**
 * Store of processed transaction ids (dedup). Backed by an in-memory set in
 * tests; by a durable store in production.
 */
export interface ProcessedIds {
  has(transactionId: string): boolean;
  add(transactionId: string): void;
}

/**
 * Lookup of a tenant's riders (for tenant-wide fan-out). Backed by a static
 * registry in the prototype; by the platform's rider data in production.
 */
export interface RiderDirectory {
  listRiders(tenantId: string): Promise<string[]>;
}

/**
 * Turn a Domain Event into Breeze delivery(ies).
 * Events whose transaction_id was already processed are skipped (at-least-once
 * delivery made effectively exactly-once).
 */
export async function processEvent(
  event: DomainEvent,
  breeze: BreezeClient,
  seen: ProcessedIds,
  riders: RiderDirectory,
): Promise<void> {
  if (seen.has(event.transaction_id)) return;
  switch (event.type) {
    case "booking_confirmed":
      if (event.rider_id === null) break; // rider-scoped event without a rider: nothing to deliver
      await breeze.deliver({
        riderId: event.rider_id,
        tenantId: event.tenant_id,
        title: "Booking confirmed",
        body: `Your AV booking ${event.data.booking_ref} is confirmed.`,
      });
      break;
    case "arrival_warning":
      if (event.rider_id === null) break;
      await breeze.deliver({
        riderId: event.rider_id,
        tenantId: event.tenant_id,
        title: "Your AV is arriving",
        body: `Your vehicle for booking ${event.data.booking_ref} is ${event.data.eta_minutes} minutes away.`,
      });
      break;
    case "service_disruption": {
      // Tenant-wide: fan out to every rider of the affected AV Service.
      const riderIds = await riders.listRiders(event.tenant_id);
      for (const riderId of riderIds) {
        await breeze.deliver({
          riderId,
          tenantId: event.tenant_id,
          title: "Service disruption",
          body: String(event.data.reason),
        });
      }
      break;
    }
  }
  seen.add(event.transaction_id);
}
