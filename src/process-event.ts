import type { DomainEvent } from "./events.js";
import { defaultTenantConfig, type TenantConfigStore } from "./tenant-config.js";

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

export interface ProcessEventOptions {
  /** Max in-flight Breeze deliveries (bounds large tenant fan-outs). Default 10. */
  maxConcurrentDeliveries?: number;
}

const DEFAULT_MAX_CONCURRENT_DELIVERIES = 10;

/**
 * Turn a Domain Event into Breeze delivery(ies).
 * Events whose transaction_id was already processed are skipped (at-least-once
 * delivery made effectively exactly-once).
 *
 * Events whose type is disabled for the tenant are not delivered. Wording comes
 * from the tenant's templates (per-tenant configuration). If any delivery
 * fails, the transaction is NOT marked processed, so the event can be
 * redelivered (the consumer leaves the SQS message in the queue).
 */
export async function processEvent(
  event: DomainEvent,
  breeze: BreezeClient,
  seen: ProcessedIds,
  riders: RiderDirectory,
  tenantConfigStore: TenantConfigStore,
  options: ProcessEventOptions = {},
): Promise<void> {
  if (seen.has(event.transaction_id)) return;

  const config = tenantConfigStore.get(event.tenant_id) ?? defaultTenantConfig();
  if (!config.enabledEventTypes.includes(event.type)) return;

  const template = config.templates[event.type];
  if (template) {
    const { title, body } = template(event);
    switch (event.type) {
      case "service_disruption": {
        // Tenant-wide: fan out to every rider of the affected AV Service,
        // with bounded in-flight deliveries so a large fan-out cannot stall
        // the consumer.
        const riderIds = await riders.listRiders(event.tenant_id);
        await mapConcurrently(
          riderIds,
          async (riderId) => {
            await breeze.deliver({ riderId, tenantId: event.tenant_id, title, body });
          },
          options.maxConcurrentDeliveries ?? DEFAULT_MAX_CONCURRENT_DELIVERIES,
        );
        break;
      }
      case "booking_confirmed":
      case "arrival_warning":
        if (event.rider_id === null) break; // rider-scoped event without a rider: nothing to deliver
        await breeze.deliver({ riderId: event.rider_id, tenantId: event.tenant_id, title, body });
        break;
    }
  }
  seen.add(event.transaction_id);
}

/**
 * Run `fn` over `items` with at most `limit` promises in flight.
 * Resolves only when every item has completed; rejects on the first failure.
 */
async function mapConcurrently<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  limit: number,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
