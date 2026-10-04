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
 * Turn a Domain Event into Breeze delivery(ies).
 * Returns true if the event was processed (including deduplicated).
 */
export async function processEvent(
  event: DomainEvent,
  breeze: BreezeClient,
): Promise<void> {
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
  }
}
