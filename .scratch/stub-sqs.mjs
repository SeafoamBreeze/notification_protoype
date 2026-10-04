// Minimal in-memory SQS stub speaking AWS JSON 1.0 (the protocol the current
// @aws-sdk/client-sqs uses) — just enough for a local end-to-end smoke test.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const messages = []; // { messageId, receiptHandle, body }
let id = 0;

const server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const target = (req.headers["x-amz-target"] ?? "").split(".")[1];
    let params = {};
    try {
      params = data ? JSON.parse(data) : {};
    } catch {}
    console.log(`[stub-sqs] ${target}`);
    const send = (obj) => {
      res.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
      res.end(JSON.stringify(obj));
    };
    if (target === "SendMessage") {
      const messageId = String(++id);
      messages.push({ messageId, receiptHandle: `rh-${messageId}`, body: params.MessageBody });
      send({
        MessageId: messageId,
        MD5OfMessageBody: createHash("md5").update(params.MessageBody ?? "").digest("hex"),
      });
    } else if (target === "ReceiveMessage") {
      const m = messages.shift();
      send(
        m
          ? {
              Messages: [
                {
                  MessageId: m.messageId,
                  ReceiptHandle: m.receiptHandle,
                  Body: m.body,
                  MD5OfBody: createHash("md5").update(m.body).digest("hex"),
                },
              ],
            }
          : {},
      );
    } else if (target === "DeleteMessage") {
      send({});
    } else {
      res.writeHead(400, { "content-type": "application/x-amz-json-1.0" });
      res.end(JSON.stringify({ __type: "Unsupported", message: target }));
    }
  });
});

server.listen(9421, () => console.log("[stub-sqs] listening on 9421"));
