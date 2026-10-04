import type { BreezeClient, BreezeNotification } from "./process-event.js";

export interface MockBreezeOptions {
  /**
   * Optional URL that receives delivery records as JSON POSTs — the scenario
   * simulator's visible log. Demo chrome only; never required for delivery.
   */
  logUrl?: string;
}

/**
 * Prototype BreezeClient: displays each delivery (the demo display) and,
 * optionally, forwards it to the scenario simulator's visible log.
 *
 * This file is the single Breeze adapter seam — when the Breeze API spec
 * arrives, the real HTTP adapter replaces this file (one-file swap).
 */
export function createMockBreeze(options: MockBreezeOptions = {}): BreezeClient {
  return {
    async deliver(notification: BreezeNotification) {
      console.log(
        [
          "📱 Breeze (mock) →",
          `   rider:   ${notification.riderId}`,
          `   tenant:  ${notification.tenantId}`,
          `   title:   ${notification.title}`,
          `   body:    ${notification.body}`,
        ].join("\n"),
      );
      if (options.logUrl) {
        // Fire-and-forget: the visible log is demo chrome and must never
        // affect delivery reliability.
        fetch(options.logUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "delivery", at: new Date().toISOString(), ...notification }),
        }).catch(() => {});
      }
    },
  };
}
