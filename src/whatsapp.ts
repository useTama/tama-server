import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const REPLY_CHARS = 4000;

export type WhatsAppInbound =
  | { id: string; sender: string; phoneNumberId: string; timestamp: string; kind: "audio"; mediaId: string; mimeType: string }
  | { id: string; sender: string; phoneNumberId: string; timestamp: string; kind: "text"; text: string };

export type WhatsAppCaptureInput = {
  messageId: string;
  sender: string;
  capturedAt: string;
  mimeType: string;
  audio: Uint8Array;
};

export type WhatsAppAskInput = { messageId: string; sender: string; question: string };

type WhatsAppDependencies = {
  db: Database;
  config: NonNullable<Config["whatsapp"]>;
  capture: (input: WhatsAppCaptureInput) => Promise<string>;
  ask: (input: WhatsAppAskInput) => Promise<string>;
  fetch?: typeof fetch;
  onError?: (message: string) => void;
};

function secretEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/** Meta signs the exact request bytes as sha256=<hex HMAC>. */
export function verifyWebhookSignature(raw: Uint8Array, signature: string | null, appSecret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const given = signature.slice("sha256=".length);
  if (!/^[a-f\d]{64}$/i.test(given)) return false;
  const expected = createHmac("sha256", appSecret).update(raw).digest("hex");
  return secretEqual(given.toLowerCase(), expected);
}

/**
 * Reduce Meta's deliberately broad webhook envelope to the only two message
 * kinds Tama accepts. Delivery receipts and other WABA events are ignored.
 */
export function extractInboundMessages(body: unknown): WhatsAppInbound[] {
  if (!body || typeof body !== "object" || (body as any).object !== "whatsapp_business_account") return [];
  const found: WhatsAppInbound[] = [];
  for (const entry of Array.isArray((body as any).entry) ? (body as any).entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "messages") continue;
      const value = change.value;
      const phoneNumberId = String(value?.metadata?.phone_number_id ?? "");
      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        const id = String(message?.id ?? "");
        const sender = String(message?.from ?? "");
        const timestampSeconds = Number(message?.timestamp);
        const timestampDate = new Date(timestampSeconds * 1000);
        const timestamp = Number.isFinite(timestampSeconds) && !Number.isNaN(timestampDate.getTime())
          ? timestampDate.toISOString()
          : new Date().toISOString();
        if (!id || !sender || !phoneNumberId) continue;
        if (message.type === "audio" && message.audio?.id) {
          found.push({
            id,
            sender,
            phoneNumberId,
            timestamp,
            kind: "audio",
            mediaId: String(message.audio.id),
            mimeType: String(message.audio.mime_type ?? "application/octet-stream"),
          });
        } else if (message.type === "text" && String(message.text?.body ?? "").trim()) {
          found.push({ id, sender, phoneNumberId, timestamp, kind: "text", text: String(message.text.body).trim() });
        }
      }
    }
  }
  return found;
}

function splitReply(text: string): string[] {
  const clean = text.trim() || "Tama did not produce a reply.";
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > REPLY_CHARS) {
    const window = rest.slice(0, REPLY_CHARS);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = boundary > REPLY_CHARS / 2 ? boundary : REPLY_CHARS;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function whatsappSource(sender: string, appSecret: string): string {
  // A keyed pseudonym keeps a personal phone number out of note frontmatter
  // and logs without leaving a plain hash that can be searched like a phonebook.
  return `whatsapp-${createHmac("sha256", appSecret).update(sender).digest("hex").slice(0, 12)}`;
}

export class WhatsAppIntegration {
  private fetcher: typeof fetch;
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private started = false;

  constructor(private deps: WhatsAppDependencies) {
    this.fetcher = deps.fetch ?? fetch;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // A process that died after claiming work left it in processing. The
    // capture idempotency key still prevents a normal retry from writing twice.
    const now = new Date().toISOString();
    this.deps.db.query("UPDATE whatsapp_messages SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'processing'")
      .run(now, now);
    void this.drain();
    this.timer = setInterval(() => void this.drain(), 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.started = false;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET") {
      const mode = url.searchParams.get("hub.mode") ?? "";
      const token = url.searchParams.get("hub.verify_token") ?? "";
      const challenge = url.searchParams.get("hub.challenge") ?? "";
      if (mode === "subscribe" && secretEqual(token, this.deps.config.verifyToken)) {
        return new Response(challenge, { status: 200, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
      }
      return new Response("forbidden\n", { status: 403 });
    }
    if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });

    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return new Response("too large\n", { status: 413 });
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > MAX_WEBHOOK_BYTES) return new Response("too large\n", { status: 413 });
    if (!verifyWebhookSignature(raw, req.headers.get("x-hub-signature-256"), this.deps.config.appSecret)) {
      return new Response("invalid signature\n", { status: 401 });
    }

    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(raw)); }
    catch { return new Response("invalid JSON\n", { status: 400 }); }

    const allowed = new Set(this.deps.config.allowedFrom);
    for (const message of extractInboundMessages(body)) {
      if (message.phoneNumberId !== this.deps.config.phoneNumberId || !allowed.has(message.sender)) continue;
      this.enqueue(message);
    }
    if (this.started) void this.drain();
    return new Response("EVENT_RECEIVED\n", { status: 200, headers: { "content-type": "text/plain" } });
  }

  private enqueue(message: WhatsAppInbound): void {
    const now = new Date().toISOString();
    this.deps.db.query(`
      INSERT OR IGNORE INTO whatsapp_messages
        (id, sender, kind, payload, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(message.id, message.sender, message.kind, JSON.stringify(message), now, now, now);
  }

  /** Public for deterministic startup checks and tests; normal use calls start. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const row = this.deps.db.query(`
          SELECT id, sender, payload, reply, attempts
          FROM whatsapp_messages
          WHERE status = 'pending' AND next_attempt_at <= ?
          ORDER BY created_at LIMIT 1
        `).get(new Date().toISOString()) as { id: string; sender: string; payload: string; reply: string | null; attempts: number } | null;
        if (!row) break;
        const now = new Date().toISOString();
        this.deps.db.query("UPDATE whatsapp_messages SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?")
          .run(now, row.id);
        try {
          const message = JSON.parse(row.payload) as WhatsAppInbound;
          let reply = row.reply;
          if (reply === null) {
            if (message.kind === "audio") {
              const media = await this.downloadMedia(message.mediaId);
              reply = await this.deps.capture({
                messageId: message.id,
                sender: message.sender,
                capturedAt: message.timestamp,
                mimeType: media.mimeType || message.mimeType,
                audio: media.bytes,
              });
            } else {
              reply = await this.deps.ask({ messageId: message.id, sender: message.sender, question: message.text });
            }
            // Sending may fail after an LLM already answered. Save the result
            // first so a retry does not pay for or vary the answer a second time.
            this.deps.db.query("UPDATE whatsapp_messages SET reply = ?, updated_at = ? WHERE id = ?")
              .run(reply, new Date().toISOString(), row.id);
          }
          await this.sendText(message.sender, reply, message.id);
          // Keep the Meta id for durable deduplication, but discard user text,
          // phone number, and answer once no retry needs them.
          this.deps.db.query("UPDATE whatsapp_messages SET status = 'done', sender = '', payload = '{}', reply = NULL, last_error = NULL, updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), row.id);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const attempt = row.attempts + 1;
          const delayMs = Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempt - 1, 10));
          const retryAt = new Date(Date.now() + delayMs).toISOString();
          this.deps.db.query(`
            UPDATE whatsapp_messages
            SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ?
            WHERE id = ?
          `).run(retryAt, detail.slice(0, 500), new Date().toISOString(), row.id);
          this.deps.onError?.(`WhatsApp message ${row.id} attempt ${attempt} failed: ${detail}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async graph(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.deps.config.accessToken}`);
    const response = await this.fetcher(`https://graph.facebook.com/${this.deps.config.graphApiVersion}/${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`WhatsApp API ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response;
  }

  private async downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const metadata = await (await this.graph(encodeURIComponent(mediaId))).json() as {
      url?: string; mime_type?: string; file_size?: number;
    };
    if (!metadata.url) throw new Error("WhatsApp media response did not include a download URL");
    if (Number(metadata.file_size) > MAX_MEDIA_BYTES) throw new Error("WhatsApp voice note is larger than 25 MB");

    const response = await this.fetcher(metadata.url, {
      headers: { authorization: `Bearer ${this.deps.config.accessToken}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`WhatsApp media download ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) throw new Error("WhatsApp voice note is larger than 25 MB");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_MEDIA_BYTES) throw new Error("WhatsApp voice note is larger than 25 MB");
    return {
      bytes: new Uint8Array(buffer),
      mimeType: metadata.mime_type ?? response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  private async sendText(to: string, text: string, replyTo: string): Promise<void> {
    for (const body of splitReply(text)) {
      await this.graph(`${encodeURIComponent(this.deps.config.phoneNumberId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          context: { message_id: replyTo },
          type: "text",
          text: { preview_url: false, body },
        }),
      });
    }
  }
}
