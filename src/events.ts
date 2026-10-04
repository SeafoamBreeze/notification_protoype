/**
 * The cross-service event contract (see docs/notification-architecture.md).
 * Producers state facts, not intentions.
 */
export interface DomainEvent {
  /** Unique per publication. */
  event_id: string;
  /** Dedup key — the same transaction republished carries the same value. */
  transaction_id: string;
  /** The AV Service (tenant) this event belongs to. */
  tenant_id: string;
  /** The affected rider; null for tenant-wide events. */
  rider_id: string | null;
  type: "booking_confirmed" | "arrival_warning" | "service_disruption";
  occurred_at: string;
  data: {
    booking_ref?: string;
    [key: string]: unknown;
  };
}
