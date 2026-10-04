import type { DomainEvent } from "./events.js";

/** Notification wording produced by a tenant template. */
export interface NotificationContent {
  title: string;
  body: string;
}

/**
 * Per-tenant (AV Service) configuration: which event types produce
 * notifications, and how they are worded (spec: "onboarding a new AV service
 * is configuration, not code").
 */
export interface TenantConfig {
  enabledEventTypes: DomainEvent["type"][];
  /** Wording per event type; an enabled type without a template is not delivered. */
  templates: Partial<Record<DomainEvent["type"], (event: DomainEvent) => NotificationContent>>;
}

/**
 * Configuration boundary (same seam pattern as BreezeClient / ProcessedIds).
 * Static in-memory registry in the prototype; a config store in production.
 */
export interface TenantConfigStore {
  get(tenantId: string): TenantConfig | undefined;
}

/** Static registry for the prototype. */
export class InMemoryTenantConfigStore implements TenantConfigStore {
  constructor(private readonly configs: Record<string, TenantConfig> = {}) {}

  get(tenantId: string): TenantConfig | undefined {
    return this.configs[tenantId];
  }
}

/**
 * Default templates — the wording from the original single-tenant design.
 * Tenants without an explicit configuration fall back to these (all event
 * types enabled).
 */
export function defaultTenantConfig(): TenantConfig {
  return {
    enabledEventTypes: ["booking_confirmed", "arrival_warning", "service_disruption"],
    templates: {
      booking_confirmed: (event) => ({
        title: "Booking confirmed",
        body: `Your AV booking ${event.data.booking_ref} is confirmed.`,
      }),
      arrival_warning: (event) => ({
        title: "Your AV is arriving",
        body: `Your vehicle for booking ${event.data.booking_ref} is ${event.data.eta_minutes} minutes away.`,
      }),
      service_disruption: (event) => ({
        title: "Service disruption",
        body: String(event.data.reason),
      }),
    },
  };
}

/** A store that answers with the default configuration for every tenant. */
export class DefaultTenantConfigStore implements TenantConfigStore {
  get(_tenantId: string): TenantConfig {
    return defaultTenantConfig();
  }
}

export function defaultTenantConfigStore(): TenantConfigStore {
  return new DefaultTenantConfigStore();
}
