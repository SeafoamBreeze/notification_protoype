import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { DomainEvent } from "./events.js";

/**
 * Scenario Simulator — stands in for the (future) transactional web app.
 *
 * Styled after the Breeze app (see sample_ui/): the "New AV booking" form
 * publishes real Domain Events through the dev queue using the same event
 * contract the web app will use; the "Inbox" feed shows the resulting Breeze
 * deliveries plus the published events (demo chrome for the cause-and-effect
 * chain).
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

function buildEvent(type: DomainEvent["type"], data: Record<string, unknown> = {}): DomainEvent {
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
      return { ...base, rider_id: RIDER_ID, type, data: { booking_ref: `AV-${Math.floor(1000 + Math.random() * 9000)}`, ...data } };
    case "arrival_warning":
      return {
        ...base,
        rider_id: RIDER_ID,
        type,
        data: { booking_ref: `AV-${Math.floor(1000 + Math.random() * 9000)}`, eta_minutes: 10, ...data },
      };
    case "service_disruption":
      return {
        ...base,
        rider_id: null, // tenant-wide: the consumer fans out to all riders
        type,
        data: { reason: "Route 7 suspended until further notice.", ...data },
      };
  }
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Breeze · AV @ PUB Woodleigh Complex</title>
<style>
  :root {
    --purple: #7b2fbe;
    --purple-dark: #6a1fb0;
    --link: #8e44ec;
    --pink: #e5399b;
    --card: #f2f2f7;
    --border: #e7e7ec;
    --text: #1c1c1e;
    --muted: #8e8e93;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    margin: 0; padding: 1.5rem 1rem; background: #e9e9ee; color: var(--text);
    display: flex; justify-content: center;
  }
  .phone {
    width: 100%; max-width: 400px; background: #fff; border-radius: 32px;
    box-shadow: 0 12px 40px rgba(0,0,0,.18); overflow: hidden;
    display: flex; flex-direction: column; min-height: 720px;
  }
  /* On small screens the app IS the screen: drop the phone-frame chrome */
  @media (max-width: 480px) {
    body { padding: 0; background: #fff; }
    .phone { max-width: none; border-radius: 0; box-shadow: none; min-height: 100dvh; }
  }
  .appbar {
    background: var(--purple); color: #fff; padding: 1rem 1.1rem;
    display: flex; align-items: center; gap: .6rem;
  }
  .b-logo {
    width: 34px; height: 34px; border-radius: 50%; background: #fff; color: var(--purple);
    font-weight: 800; font-size: 1.25rem; display: flex; align-items: center; justify-content: center;
    flex: none;
  }
  .appbar .name { font-weight: 700; font-size: 1.02rem; line-height: 1.2; }
  .appbar .sub { font-size: .78rem; opacity: .85; }
  main { padding: 1rem 1rem 1.5rem; overflow-y: auto; flex: 1; }

  .accordion { background: var(--card); border-radius: 14px; padding: .8rem 1rem; margin-bottom: 1rem; }
  .acc-head { font-weight: 700; font-size: 1.05rem; display: flex; justify-content: space-between; align-items: center; }
  .acc-head .chev { color: var(--muted); }
  .field { margin-top: .9rem; }
  .field label { display: block; font-weight: 600; font-size: .86rem; margin-bottom: .35rem; }
  .field select, .field input {
    width: 100%; padding: .7rem .9rem; font-size: .95rem; color: var(--text);
    border: 1px solid var(--border); border-radius: 12px; background: #fff;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238e8e93' stroke-width='2' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right .9rem center;
  }
  .field select:invalid, .field select option[value=""] { color: var(--muted); }
  .warning { color: var(--pink); font-size: .82rem; margin: .9rem 0 0; display: none; }
  .warning.show { display: block; }

  .pill {
    width: 100%; border: none; border-radius: 999px; padding: .85rem 1rem;
    font-size: 1rem; font-weight: 700; cursor: pointer; margin-top: .8rem;
  }
  .pill.primary { background: var(--purple); color: #fff; }
  .pill.primary:disabled { background: #d9d9e3; color: #9a9aa5; cursor: default; }
  .pill.outline { background: #fff; color: var(--purple); border: 1.5px solid var(--purple); font-weight: 600; padding: .7rem 1rem; }
  .pill.outline:disabled { opacity: .5; cursor: default; }
  .sim { margin-top: 1.2rem; }
  .sim h3, #inbox h3 {
    font-size: .78rem; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); margin: 0 0 .1rem;
  }
  .hint { font-size: .78rem; color: var(--muted); margin: .3rem 0 0; }

  #inbox { margin-top: 1.4rem; }
  .pub-line {
    text-align: center; color: var(--muted); font-size: .75rem;
    margin: .7rem 0; display: flex; align-items: center; gap: .5rem;
  }
  .pub-line::before, .pub-line::after { content: ""; flex: 1; height: 1px; background: var(--border); }
  .notif {
    display: flex; gap: .7rem; background: #fff; border: 1px solid var(--border);
    border-radius: 16px; padding: .85rem .9rem; margin-bottom: .7rem;
    box-shadow: 0 2px 8px rgba(0,0,0,.05);
  }
  .notif .b-logo { width: 30px; height: 30px; font-size: 1.05rem; }
  .notif .title { font-weight: 700; font-size: .95rem; }
  .notif .body { font-size: .9rem; margin-top: .15rem; }
  .notif .meta { font-size: .72rem; color: var(--muted); margin-top: .3rem; }
</style>
</head>
<body>
<div class="phone">
  <header class="appbar">
    <div class="b-logo">b</div>
    <div>
      <div class="name">Breeze</div>
      <div class="sub">AV @ PUB Woodleigh Complex</div>
    </div>
  </header>
  <main>
    <section class="accordion">
      <div class="acc-head">New AV booking <span class="chev">⌃</span></div>
      <div class="field">
        <label for="f-date">Requested trip date</label>
        <input id="f-date" type="date">
      </div>
      <div class="field">
        <label for="f-mode">AV service mode</label>
        <select id="f-mode" required>
          <option value="" selected>Select 1 of 3 AV service modes</option>
          <option>Fixed Route</option>
          <option>On-Demand Service</option>
          <option>Emergency Booking</option>
        </select>
      </div>
      <div class="field">
        <label for="f-from">Boarding station</label>
        <select id="f-from" required>
          <option value="" selected>Select from applicable stations</option>
        </select>
      </div>
      <div class="field">
        <label for="f-to">Destination station</label>
        <select id="f-to" required>
          <option value="" selected>Select from applicable stations</option>
        </select>
      </div>
      <div class="field">
        <label for="f-pax">Number of passengers</label>
        <select id="f-pax"></select>
      </div>
      <div class="field">
        <label for="f-eqp">Number of pieces of bulky equipment</label>
        <select id="f-eqp"></select>
      </div>
      <div class="field">
        <label for="f-time">Requested boarding time</label>
        <input id="f-time" type="time" required>
      </div>
      <p class="warning" id="warn">Only 2 seats are available at the selected timeslot. Please edit booking parameters to proceed.</p>
    </section>

    <button class="pill primary" id="submit" disabled>Submit AV booking request</button>

    <section class="sim">
      <h3>Simulate service events</h3>
      <button class="pill outline" id="arrival">AV arriving in 10 mins</button>
      <button class="pill outline" id="disruption">Service disruption</button>
      <p class="hint">Each action publishes a real Domain Event to the dev SQS queue; the notification microservice delivers it via Breeze (mock).</p>
    </section>

    <section id="inbox">
      <h3>Inbox</h3>
      <div id="feed"></div>
    </section>
  </main>
</div>
<script>
  // Populate station / passenger / equipment options
  for (const id of ["f-from", "f-to"]) {
    const sel = document.getElementById(id);
    for (let i = 1; i <= 8; i++) sel.add(new Option("Station " + i));
  }
  const pax = document.getElementById("f-pax");
  for (let i = 1; i <= 13; i++) pax.add(new Option(String(i), String(i), false, i === 1));
  const eqp = document.getElementById("f-eqp");
  for (let i = 0; i <= 2; i++) eqp.add(new Option(String(i), String(i), false, i === 0));

  // Enable submit when the required fields are set and seats are available
  const submit = document.getElementById("submit");
  const warn = document.getElementById("warn");
  function syncForm() {
    const complete = ["f-date", "f-mode", "f-from", "f-to", "f-time"].every((id) => document.getElementById(id).value);
    const noSeats = Number(pax.value) > 2;
    warn.classList.toggle("show", noSeats);
    submit.disabled = !(complete && !noSeats);
  }
  document.querySelectorAll(".accordion select, .accordion input").forEach((el) => el.addEventListener("change", syncForm));

  let lastBookingRef = null;
  async function publish(payload) {
    await fetch("/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    refresh();
  }
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    lastBookingRef = "AV-" + Math.floor(1000 + Math.random() * 9000);
    await publish({
      type: "booking_confirmed",
      data: {
        booking_ref: lastBookingRef,
        trip_date: document.getElementById("f-date").value,
        mode: document.getElementById("f-mode").value,
        from: document.getElementById("f-from").value,
        to: document.getElementById("f-to").value,
        passengers: Number(pax.value),
        equipment: Number(eqp.value),
        boarding_time: document.getElementById("f-time").value,
      },
    });
    syncForm();
  });
  document.getElementById("arrival").addEventListener("click", (e) => {
    e.target.disabled = true;
    publish({ type: "arrival_warning", data: lastBookingRef ? { booking_ref: lastBookingRef, eta_minutes: 10 } : { eta_minutes: 10 } })
      .finally(() => (e.target.disabled = false));
  });
  document.getElementById("disruption").addEventListener("click", (e) => {
    e.target.disabled = true;
    publish({ type: "service_disruption", data: { reason: "Route 7 suspended until further notice." } })
      .finally(() => (e.target.disabled = false));
  });

  // Inbox feed: published events (cause) + Breeze deliveries (effect)
  const feed = document.getElementById("feed");
  let lastCount = 0;
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function timeOf(iso) { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  async function refresh() {
    const res = await fetch("/log");
    const entries = await res.json();
    for (const e of entries.slice(lastCount)) {
      const div = document.createElement("div");
      if (e.kind === "published") {
        div.className = "pub-line";
        div.textContent = "published " + e.type + (e.data && e.data.booking_ref ? " · " + e.data.booking_ref : "") + " · " + timeOf(e.at);
      } else {
        div.className = "notif";
        div.innerHTML =
          '<div class="b-logo">b</div><div>' +
          '<div class="title">' + esc(e.title || "Notification") + "</div>" +
          '<div class="body">' + esc(e.body || "") + "</div>" +
          '<div class="meta">to ' + esc(e.riderId) + " · " + timeOf(e.at) + "</div>" +
          "</div>";
      }
      feed.appendChild(div);
    }
    lastCount = entries.length;
  }
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
        const body = JSON.parse(await readBody(req)) as { type?: string; data?: Record<string, unknown> };
        const type = body.type as DomainEvent["type"];
        if (!["booking_confirmed", "arrival_warning", "service_disruption"].includes(type)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unknown scenario type" }));
          return;
        }
        const event = buildEvent(type, body.data);
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
        res.end(JSON.stringify({}));
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
