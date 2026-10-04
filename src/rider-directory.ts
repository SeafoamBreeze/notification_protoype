import type { RiderDirectory } from "./process-event.js";

/**
 * Static rider registry for the prototype (the RiderDirectory seam).
 * Production will back this with the platform's rider data.
 */
export class InMemoryRiderDirectory implements RiderDirectory {
  constructor(private readonly ridersByTenant: Record<string, string[]> = {}) {}

  async listRiders(tenantId: string): Promise<string[]> {
    return this.ridersByTenant[tenantId] ?? [];
  }
}
