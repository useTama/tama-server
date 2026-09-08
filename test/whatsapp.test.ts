import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import {
  WhatsAppIntegration,
  extractInboundMessages,
  verifyWebhookSignature,
  whatsappSource,
  type WhatsAppAskInput,
  type WhatsAppCaptureInput,
} from "../src/whatsapp.ts";
import { ASK_PER_WINDOW, noticeFor } from "../src/rate-limit.ts";

let dir: string;
let db: Database;

const waConfig: NonNullable<Config["whatsapp"]> = {
  phoneNumberId: "111222333",
  allowedFrom: ["919876543210"],
  accessToken: "access-secret",
  appSecret: "app-secret",
  verifyToken: "verify-secret",
  graphApiVersion: "v23.0",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tama-whatsapp-"));
  db = openDb(join(dir, "tama.db"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function envelope(messages: unknown[], phoneNumberId = waConfig.phoneNumberId): object {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: phoneNumberId },
      messages,
    } }] }],
  };
}

function signedRequest(body: object, signature = true): Request {
  const raw = JSON.stringify(body);
  const digest = createHmac("sha256", waConfig.appSecret).update(raw).digest("hex");
  return new Request("https://tama.example/webhooks/whatsapp", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${signature ? digest : "0".repeat(64)}` },
    body: raw,
  });
}

function integration(options: {
  fetch?: typeof fetch;
  capture?: (input: WhatsAppCaptureInput) => Promise<string>;
  ask?: (input: WhatsAppAskInput) => Promise<string>;
} = {}): WhatsAppIntegration {
  return new WhatsAppIntegration({
    db,
    config: waConfig,
    capture: options.capture ?? (async () => "saved"),
    ask: options.ask ?? (async () => "answered"),
    fetch: options.fetch,
  });
}

test("webhook verification requires the configured verify token", async () => {
  const wa = integration();
  const ok = await wa.handle(new Request(
    "https://tama.example/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=challenge-123",
  ));
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("challenge-123");

  const denied = await wa.handle(new Request(
    "https://tama.example/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x",
  ));
  expect(denied.status).toBe(403);
});

test("the signature covers the exact webhook bytes", () => {
  const raw = new TextEncoder().encode('{"hello":"world"}');
  const digest = createHmac("sha256", waConfig.appSecret).update(raw).digest("hex");
  expect(verifyWebhookSignature(raw, `sha256=${digest}`, waConfig.appSecret)).toBe(true);
  expect(verifyWebhookSignature(new TextEncoder().encode('{"hello": "world"}'), `sha256=${digest}`, waConfig.appSecret)).toBe(false);
  expect(verifyWebhookSignature(raw, null, waConfig.appSecret)).toBe(false);
});

test("the webhook extracts voice notes and text but ignores delivery receipts", () => {
  const body = envelope([
    { from: "919876543210", id: "wamid.audio", timestamp: "1788700000", type: "audio", audio: { id: "media-1", mime_type: "audio/ogg; codecs=opus", voice: true } },
    { from: "919876543210", id: "wamid.text", timestamp: "1788700001", type: "text", text: { body: "what did I say about batteries?" } },
  ]);
  expect(extractInboundMessages(body)).toEqual([
    {
      id: "wamid.audio", sender: "919876543210", phoneNumberId: "111222333",
      timestamp: new Date(1788700000 * 1000).toISOString(), kind: "audio",
      mediaId: "media-1", mimeType: "audio/ogg; codecs=opus",
    },
    {
      id: "wamid.text", sender: "919876543210", phoneNumberId: "111222333",
      timestamp: new Date(1788700001 * 1000).toISOString(), kind: "text",
      text: "what did I say about batteries?",
    },
  ]);
  expect(extractInboundMessages(envelope([]))).toEqual([]);
});

test("invalid signatures are rejected and allowed messages are durably deduplicated", async () => {
  const wa = integration();
  const message = { from: "919876543210", id: "wamid.one", timestamp: "1788700000", type: "text", text: { body: "hello" } };

  expect((await wa.handle(signedRequest(envelope([message]), false))).status).toBe(401);
  expect((db.query("SELECT count(*) AS n FROM whatsapp_messages").get() as { n: number }).n).toBe(0);

  expect((await wa.handle(signedRequest(envelope([message])))).status).toBe(200);
  expect((await wa.handle(signedRequest(envelope([message])))).status).toBe(200);
  expect((db.query("SELECT count(*) AS n FROM whatsapp_messages").get() as { n: number }).n).toBe(1);

  const denied = { ...message, id: "wamid.denied", from: "12025550123" };
  const wrongNumber = envelope([{ ...message, id: "wamid.wrong" }], "999888777");
  await wa.handle(signedRequest(envelope([denied])));
  await wa.handle(signedRequest(wrongNumber));
  expect((db.query("SELECT count(*) AS n FROM whatsapp_messages").get() as { n: number }).n).toBe(1);
});

test("a queued voice note is downloaded, captured with its message id, and acknowledged", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://lookaside.example/media-1") return new Response(new Uint8Array([1, 2, 3]));
    if (url.endsWith("/media-1")) {
      return Response.json({ url: "https://lookaside.example/media-1", mime_type: "audio/ogg", file_size: 3 });
    }
    if (url.endsWith("/111222333/messages")) return Response.json({ messages: [{ id: "outbound-1" }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  let captured: WhatsAppCaptureInput | undefined;
  const wa = integration({
    fetch: fakeFetch,
    capture: async (input) => { captured = input; return "Saved to Inbox/note.md"; },
  });
  const message = { from: "919876543210", id: "wamid.audio", timestamp: "1788700000", type: "audio", audio: { id: "media-1", mime_type: "audio/ogg", voice: true } };
  await wa.handle(signedRequest(envelope([message])));
  await wa.drain();

  expect(captured?.messageId).toBe("wamid.audio");
  expect(captured?.sender).toBe("919876543210");
  expect([...captured!.audio]).toEqual([1, 2, 3]);
  expect(captured?.capturedAt).toBe(new Date(1788700000 * 1000).toISOString());
  expect((db.query("SELECT status, attempts, sender, payload, reply FROM whatsapp_messages WHERE id = ?").get("wamid.audio") as any))
    .toEqual({ status: "done", attempts: 1, sender: "", payload: "{}", reply: null });

  const outbound = calls.find((call) => call.url.endsWith("/messages"))!;
  expect(new Headers(outbound.init?.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(String(outbound.init?.body))).toMatchObject({
    messaging_product: "whatsapp", to: "919876543210", context: { message_id: "wamid.audio" },
    type: "text", text: { body: "Saved to Inbox/note.md" },
  });
});

test("text messages ask the second brain and transient failures remain queued", async () => {
  let failSend = true;
  const fakeFetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/messages") && failSend) return new Response("rate limited", { status: 429 });
    return Response.json({ messages: [{ id: "outbound" }] });
  }) as typeof fetch;
  let question = "";
  let asks = 0;
  const wa = integration({ fetch: fakeFetch, ask: async (input) => {
    asks++;
    question = input.question;
    return "From your notes: use LiFePO4.";
  } });
  const message = { from: "919876543210", id: "wamid.question", timestamp: "1788700000", type: "text", text: { body: "  Which battery?  " } };
  await wa.handle(signedRequest(envelope([message])));
  await wa.drain();
  expect(question).toBe("Which battery?");
  const failed = db.query("SELECT status, attempts, last_error FROM whatsapp_messages WHERE id = ?").get("wamid.question") as any;
  expect(failed.status).toBe("pending");
  expect(failed.attempts).toBe(1);
  expect(failed.last_error).toContain("429");

  failSend = false;
  db.query("UPDATE whatsapp_messages SET next_attempt_at = ? WHERE id = ?").run(new Date(0).toISOString(), "wamid.question");
  await wa.drain();
  expect((db.query("SELECT status, attempts FROM whatsapp_messages WHERE id = ?").get("wamid.question") as any))
    .toEqual({ status: "done", attempts: 2 });
  expect(asks).toBe(1);
});

test("WhatsApp note sources are stable and do not reveal the phone number", () => {
  const source = whatsappSource("919876543210", "app-secret");
  expect(source).toBe(whatsappSource("919876543210", "app-secret"));
  expect(source).not.toBe(whatsappSource("919876543210", "another-secret"));
  expect(source).not.toContain("919876543210");
  expect(source).toMatch(/^whatsapp-[a-f\d]{12}$/);
});

// ---- #56: a per-sender ceiling, checked at admission --------------------

const flood = (n: number, kind: "text" | "audio" = "text") =>
  Array.from({ length: n }, (_, i) =>
    kind === "text"
      ? { from: "919876543210", id: `wamid.f${i}`, timestamp: "1788700000", type: "text", text: { body: `q${i}` } }
      : { from: "919876543210", id: `wamid.f${i}`, timestamp: "1788700000", type: "audio", audio: { id: `m${i}`, mime_type: "audio/ogg", voice: true } });

test("a flood is refused before it ever reaches the durable inbox", async () => {
  const wa = integration();
  const res = await wa.handle(signedRequest(envelope(flood(ASK_PER_WINDOW + 4))));
  // Meta is still acknowledged. Refusing the webhook would make it retry.
  expect(res.status).toBe(200);

  const rows = db.query("SELECT id, reply FROM whatsapp_messages ORDER BY id").all() as Array<{ id: string; reply: string | null }>;
  // The answerable ones, plus exactly one canned notice. The rest never became
  // rows at all, which is the whole point: this inbox is durable, so limiting
  // in the worker would persist the flood and then grind through it with the
  // owner's next question queued behind.
  expect(rows.length).toBe(ASK_PER_WINDOW + 1);
  expect(rows.filter((r) => r.reply !== null)).toHaveLength(1);
});

test("the notice is delivered without spending a model call", async () => {
  const sent: string[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/messages")) sent.push(JSON.parse(String(init?.body)).text.body);
    return Response.json({ messages: [{ id: "outbound" }] });
  }) as typeof fetch;
  let asks = 0;
  const wa = integration({ fetch: fakeFetch, ask: async () => { asks++; return "answered"; } });

  await wa.handle(signedRequest(envelope(flood(ASK_PER_WINDOW + 2))));
  await wa.drain();

  // The refusal costs nothing: drain() only calls ask when it finds a null
  // reply, and the notice was enqueued with its text already set.
  expect(asks).toBe(ASK_PER_WINDOW);
  expect(sent).toHaveLength(ASK_PER_WINDOW + 1);
  expect(sent.at(-1)).toBe(noticeFor("text"));
});

test("voice notes get their own budget, so a run of dictation is not throttled", async () => {
  // Capture is the product working. Exhausting the ask budget must not stop a
  // voice note being saved.
  const wa = integration();
  await wa.handle(signedRequest(envelope(flood(ASK_PER_WINDOW + 3))));
  const before = (db.query("SELECT count(*) AS n FROM whatsapp_messages").get() as { n: number }).n;

  await wa.handle(signedRequest(envelope([
    { from: "919876543210", id: "wamid.voice", timestamp: "1788700000", type: "audio", audio: { id: "m", mime_type: "audio/ogg", voice: true } },
  ])));
  const after = (db.query("SELECT count(*) AS n FROM whatsapp_messages").get() as { n: number }).n;
  expect(after).toBe(before + 1);
  expect((db.query("SELECT reply FROM whatsapp_messages WHERE id = ?").get("wamid.voice") as any).reply).toBeNull();
});

test("the sender is a pseudonym in the limit table, never a phone number", async () => {
  const wa = integration();
  await wa.handle(signedRequest(envelope(flood(2))));
  const rows = db.query("SELECT scope, subject FROM rate_limits").all() as Array<{ scope: string; subject: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.scope).toBe("whatsapp:text");
  expect(rows[0]!.subject).toBe(whatsappSource("919876543210", waConfig.appSecret));
  expect(JSON.stringify(rows)).not.toContain("919876543210");
});
