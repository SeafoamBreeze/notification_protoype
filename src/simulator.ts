import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { DomainEvent } from "./events.js";

/**
 * Scenario Simulator — stands in for the (future) transactional web app.
 *
 * A thin publisher: buttons publish real Domain Events through the real dev
 * queue using the same event contract the web app will use. The visible event
 * log (published events + resulting Breeze deliveries) is demo chrome.
 *
 * Configuration via environment:
 *
 *   SQS_QUEUE_URL   (required) URL of the dev domain-events queue
 *   PORT            (default: 3000)
 *   AWS_REGION      (default: us-east-1)
 *   AWS_ENDPOINT    (optional) custom SQS endpoint
 *   AWS credentials standard environment variables
 */

interface LogEntry {
  at: string;
  kind: "published" | "delivery";
  [key: string]: unknown;
}

const TENANT_ID = "demo-av-service";
const RIDER_ID = "rider-demo-1";

function buildEvent(type: DomainEvent["type"]): DomainEvent {
  const base = {
    event_id: randomUUID(),
    // A fresh transaction per publication; republishing the same button press
    // in a race would carry the same id and be deduplicated by the consumer.
    transaction_id: randomUUID(),
    tenant_id: TENANT_ID,
    occurred_at: new Date().toISOString(),
  };
  switch (type) {
    case "booking_confirmed":
      return { ...base, rider_id: RIDER_ID, type, data: { booking_ref: "AV-1042" } };
    case "arrival_warning":
      return {
        ...base,
        rider_id: RIDER_ID,
        type,
        data: { booking_ref: "AV-1042", eta_minutes: 10 },
      };
    case "service_disruption":
      return {
        ...base,
        rider_id: null, // tenant-wide: the consumer fans out to all riders
        type,
        data: { reason: "Route 7 suspended until further notice." },
      };
  }
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>AV Notification Scenario Simulator</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 720px; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  .hint { color: #666; font-size: 0.9rem; }
  button { font-size: 1rem; padding: 0.6rem 1rem; margin: 0 0.5rem 0.5rem 0; cursor: pointer; }
  #log { margin-top: 1.5rem; border: 1px solid #ddd; border-radius: 8px; padding: 0.75rem; height: 320px; overflow-y: auto; background: #fafafa; font-size: 0.85rem; }
  .entry { margin-bottom: 0.6rem; padding: 0.4rem 0.6rem; border-radius: 6px; background: #fff; border: 1px solid #eee; }
  .entry .meta { color: #888; font-size: 0.75rem; }
  .badge { display: inline-block; font-size: 0.7rem; font-weight: 600; padding: 0.1rem 0.45rem; border-radius: 10px; margin-right: 0.4rem; }
  .badge.published { background: #dbeafe; color: #1e40af; }
  .badge.delivery { background: #dcfce7; color: #166534; }
</style>
</head>
<body>
<h1>AV Notification Scenario Simulator</h1>
<p class="hint">Each button publishes a real Domain Event to the dev SQS queue. The notification microservice picks it up and delivers via Breeze (mock). The log below shows the cause-and-effect chain.</p>
<button data-type="booking_confirmed">Booking confirmed</button>
<button data-type="arrival_warning">Vehicle arriving in 10 min</button>
<button data-type="service_disruption">Service disruption</button>
<div id="log"></div>
<script>
  const logEl = document.getElementById("log");
  let lastCount = 0;
  async function refresh() {
    const res = await fetch("/log");
    const entries = await res.json();
    for (const e of entries.slice(lastCount)) {
      const div = document.createElement("div");
      div.className = "entry";
      const title = e.kind === "published" ? e.type : (e.title || "delivery");
      const detail = e.kind === "published"
        ? "published to queue (tenant: " + e.tenant_id + ", rider: " + (e.rider_id ?? "all riders") + ")"
        : "to " + e.riderId + " — " + e.body;
      div.innerHTML = '<span class="badge ' + e.kind + '">' + e.kind + "</span>"
        + "<strong>" + title + "</strong><br><span class='meta'>" + e.at + "</span><br>" + detail;
      logEl.appendChild(div);
    }
    lastCount = entries.length;
    logEl.scrollTop = logEl.scrollHeight;
  }
  document.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await fetch("/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: btn.dataset.type }),
      });
      btn.disabled = false;
      refresh();
    });
  });
  refresh();
  setInterval(refresh, 1000);
</script>
</body>
</html>`;

async function main(): Promise<void> {
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) {
    console.error("SQS_QUEUE_URL is required (URL of the dev domain-events queue)");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 3000);

  const sqs = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.AWS_ENDPOINT ? { endpoint: process.env.AWS_ENDPOINT } : {}),
  });

  const log: LogEntry[] = [];

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE);
      } else if (req.method === "GET" && req.url === "/log") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(log));
      } else if (req.method === "POST" && req.url === "/publish") {
        const body = JSON.parse(await readBody(req)) as { type?: string };
        const type = body.type as DomainEvent["type"];
        if (!["booking_confirmed", "arrival_warning", "service_disruption"].includes(type)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unknown scenario type" }));
          return;
        }
        const event = buildEvent(type);
        await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(event) }));
        log.push({ at: event.occurred_at, kind: "published", ...event });
        console.log(`published ${event.type} (${event.event_id}) to ${queueUrl}`);
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ event_id: event.event_id }));
      } else if (req.method === "POST" && req.url === "/log-entry") {
        const entry = JSON.parse(await readBody(req)) as {
          kind: LogEntry["kind"];
        } & Record<string, unknown>;
        log.push({ at: new Date().toISOString(), ...entry });
        res.writeHead(202, { "content-type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    } catch (err) {
      console.error("simulator error:", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(port, () => {
    console.log(`scenario simulator listening on http://localhost:${port} (queue: ${queueUrl})`);
  });
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
