export type Level = "info" | "warn" | "error";

export type Event = {
  level: Level;
  title: string;
  message: string;
  /** A note path or similar, appended to the body when present. */
  ref?: string;
};

/**
 * A notification channel.
 *
 * Why ntfy and not APNs or FCM: pushing through Apple or Google requires a
 * developer account and per-app credentials. For a project anyone is meant to
 * self-host, that is cost and paperwork pushed onto every single user. ntfy is
 * an HTTP POST to a topic, works on both platforms, and can itself be self-hosted.
 *
 * A notification that fails must NEVER break a capture. A note that landed but
 * failed to notify is a working capture with a quiet confirmation. A note lost
 * because the notifier threw is a lost thought.
 */
export interface Notifier {
  readonly name: string;
  send(e: Event): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  readonly name = "console";
  async send(e: Event) {
    const tag = e.level === "error" ? "!!" : e.level === "warn" ? " !" : "  ";
    console.log(`${tag} ${e.title} — ${e.message}${e.ref ? ` (${e.ref})` : ""}`);
  }
}

export class NtfyNotifier implements Notifier {
  readonly name = "ntfy";
  constructor(
    private url: string,
    private topic: string,
    private token?: string,
  ) {}

  async send(e: Event) {
    const priority = e.level === "error" ? "high" : e.level === "warn" ? "default" : "low";
    const tags = e.level === "error" ? "rotating_light" : e.level === "warn" ? "warning" : "memo";
    const headers: Record<string, string> = {
      Title: e.title.slice(0, 200),
      Priority: priority,
      Tags: tags,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const body = e.ref ? `${e.message}\n${e.ref}` : e.message;
    const res = await fetch(`${this.url.replace(/\/+$/, "")}/${this.topic}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Wraps any notifier so a failure is logged and swallowed rather than thrown.
 * Every call site in the capture path uses this.
 */
export function safeNotify(n: Notifier, e: Event): void {
  n.send(e).catch((err) => {
    console.error(`notify failed (${n.name}): ${err instanceof Error ? err.message : err}`);
  });
}
