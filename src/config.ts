import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { SARVAM_URL, type SttConfig } from "./stt.ts";
import { BUILTIN_VIEWS, resolveView, type View } from "./views.ts";
import type { AnswerStyle, Voice } from "./ask.ts";
import { ROUTE_DEFAULTS, type RouteConfig } from "./route.ts";

export type Config = {
  vault: { path: string; inbox: string };
  stt: SttConfig;
  server: { port: number; adminToken: string };
  notify: {
    provider: "console" | "ntfy";
    ntfy: { url: string; topic: string; token?: string };
    digestAt: string;
  };
  safety: { allowUnbackedVault: boolean; dryRun: boolean };
  /**
   * Optional by design. With no `ask` block the server runs exactly as it did
   * before this feature existed: capture works, /ask returns 501. That is the
   * free, accountless tier, and it must never require a key to keep working.
   */
  ask?: {
    provider: "anthropic" | "openai-compatible";
    model: string;
    apiKey?: string;
    /** Name of an environment variable containing the provider credential. */
    apiKeyEnv?: string;
    baseUrl?: string;
    maxChunks: number;
    /**
     * Output cap per answer. Optional: llm.ts owns the default, and the reason
     * it is configurable is that a gateway refuses a request whose max_tokens
     * exceeds the remaining balance, whatever the answer would have cost.
     */
    maxTokens?: number;
  };
  /**
   * Post-processing. Absent, the Inbox is the second brain: captures pile up as
   * dated files, nothing links to them and no note is ever rewritten. Present,
   * a cycle files each capture into the note it belongs in and empties the
   * Inbox. It needs `ask`, because deciding where a thought belongs needs a
   * model, and it reuses that one rather than adding a second key to keep.
   */
  route?: RouteConfig & { enabled: boolean };
  /**
   * What the user named this. The wizard asks, so the assistant should use it
   * rather than calling itself Tama at someone who named it something else.
   */
  world?: { name?: string };
  /** Named subsets of the vault, referenced by audiences. See views.ts. */
  views?: Record<string, View>;
  /**
   * Who may talk to this vault, and what they get. Keyed by name, because a
   * client refers to an audience by name and more than one client will: the
   * same audience is reachable over WhatsApp, Slack and the web UI, so only the
   * matching belongs in a client's own config.
   */
  audiences?: Record<string, Audience>;
  /**
   * Optional WhatsApp Cloud API transport. It is an adapter over capture and
   * ask, not a dependency of either path: deleting this block removes every
   * WhatsApp route and leaves the core HTTP API unchanged.
   */
  whatsapp?: {
    phoneNumberId: string;
    allowedFrom: string[];
    /** Public origin printed by setup; Meta calls the fixed webhook path on it. */
    publicBaseUrl?: string;
    accessToken: string;
    appSecret: string;
    verifyToken: string;
    graphApiVersion: string;
  };
  dataDir: string;
};

export function defaultConfigPath(): string {
  return process.env.TAMA_CONFIG ?? (existsSync("tama.config.json") ? resolve("tama.config.json") : resolve(process.env.HOME ?? ".", ".config/tama/tama.config.json"));
}

/** Shared by the server and the wizard, so `--config` means one thing in both. */
export function configPathFromArgs(args: string[]): string {
  const flag = args.indexOf("--config");
  if (flag === -1) return defaultConfigPath();
  const path = args[flag + 1];
  if (!path || path.startsWith("--")) throw new Error("--config requires a path");
  return resolve(path);
}

/**
 * An audience is deliberately all closed sets except `note`.
 *
 * Every field a person configures per group has a small number of legal values,
 * so `tama settings` can offer menus and a config file can be reviewed at a
 * glance. The one freeform field carries facts about the room, never policy.
 */
export type Audience = {
  /** A view name. Defaults to `none`, so a misconfigured audience knows nothing. */
  view: string;
  voice: Voice;
  /** Required when `voice` is "custom": how to talk, in the owner's words. */
  voicePrompt?: string;
  /** Whether answers may name note paths. Off for anywhere shared. */
  cite: boolean;
  length: AnswerStyle;
  onNoMatch: "say-so" | "just-talk";
  /**
   * How much of a group's traffic it answers.
   *
   * "in-conversation" is the one people actually want: it answers when spoken
   * to and then keeps answering for as long as the exchange lasts, the way a
   * person in the group would, rather than needing to be tagged every line or
   * replying to all seventeen people all day.
   */
  mention: "always" | "when-mentioned" | "in-conversation";
  /** Never captures into the vault. Groups default to false. */
  capture: boolean;
  note?: string;
  /**
   * Who is in the room, one line each. Facts, so a reply can be specific: a
   * roast that could be aimed at anyone is not a roast.
   *
   * Kept out of the vault deliberately. These are notes about other people,
   * they belong to the room rather than to the owner's second brain, and they
   * should not turn up in an answer to an unrelated question.
   */
  people?: Record<string, string>;
  /**
   * Whatever a message might arrive labelled as, mapped to the name used in
   * `people`.
   *
   * The failure this fixes: `people` is keyed by name, and a group message
   * arrives labelled with whatever the client could work out about the sender.
   * The bridge tries the WhatsApp push name, then the address-book name, then
   * gives up and uses the phone number. So the model was handed "Who is in
   * this room: Priya, Anand" alongside "A message from 919876543210" and
   * nothing whatsoever connecting the two. In a group it could not tell who
   * was talking, which is most of what being in a group means.
   *
   * Joining them by hoping a push name matches a config key is not a fix: push
   * names carry emoji, surnames and nicknames, and a person can change theirs
   * whenever they like.
   *
   * Numbers are stored as digits only, aliases lowercased, so a lookup does
   * not depend on how either side was typed.
   */
  identities?: Record<string, string>;
};

/**
 * The name to attribute a message to, from whatever the client called the
 * sender.
 *
 * Unmapped labels pass through unchanged. A number the owner has not named is
 * still better than "someone", and inventing a name here would be worse than
 * either.
 */
export function resolveSpeaker(
  raw: string | undefined,
  identities?: Record<string, string>,
): string | undefined {
  const label = raw?.trim();
  if (!label) return undefined;
  if (!identities) return label;

  // A phone number only counts as one when the whole label is digits and the
  // punctuation numbers are written with. Stripping non-digits from "Priya 2"
  // would otherwise look her up as "2".
  if (/^[+\d\s().-]+$/.test(label)) {
    const digits = label.replace(/\D/g, "");
    // Matched from the right, so a number stored with a country code still
    // resolves one written without it, and the reverse.
    for (const [key, who] of Object.entries(identities)) {
      if (!/^\d+$/.test(key)) continue;
      const short = key.length <= digits.length ? key : digits;
      const long = key.length <= digits.length ? digits : key;
      if (short.length >= 7 && long.endsWith(short)) return who;
    }
  }
  return identities[label.toLowerCase()] ?? label;
}

const VOICE_NAMES: Voice[] = ["neutral", "friend", "roast", "custom"];

function parseAudience(name: string, raw: any, views: Record<string, View>): Audience {
  const enumerated = <T extends string>(field: string, value: unknown, allowed: readonly T[], fallback: T): T => {
    if (value === undefined) return fallback;
    if (!allowed.includes(value as T)) {
      throw new Error(`config: audiences.${name}.${field} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
    }
    return value as T;
  };

  // Resolved here rather than at request time so a typo is a startup failure.
  // A view name that silently meant "everything" is the exact accident this
  // mechanism exists to prevent, and the audience that gets it wrong is
  // typically the one shared with other people.
  const view = String(raw?.view ?? "none");
  resolveView(views, view);

  const audience: Audience = {
    view,
    voice: enumerated("voice", raw?.voice, VOICE_NAMES, "friend"),
    cite: raw?.cite === undefined ? view === "everything" : Boolean(raw.cite),
    length: enumerated("length", raw?.length, ["prose", "chat"] as const, "chat"),
    onNoMatch: enumerated("onNoMatch", raw?.onNoMatch, ["say-so", "just-talk"] as const, "say-so"),
    mention: enumerated("mention", raw?.mention, ["always", "when-mentioned", "in-conversation"] as const, "in-conversation"),
    capture: Boolean(raw?.capture ?? false),
  };
  if (raw?.note !== undefined) audience.note = String(raw.note);
  if (raw?.people && typeof raw.people === "object") {
    const people: Record<string, string> = {};
    const identities: Record<string, string> = {};

    // A key claimed by two people is a typo with a silent consequence: one of
    // them gets the other's messages attributed to them, and the owner has no
    // way to see it. Failing at startup is the only place that is cheap.
    const claim = (key: string, who: string) => {
      if (!key) return;
      const held = identities[key];
      if (held && held !== who) {
        throw new Error(
          `config: audiences.${name}.people maps ${JSON.stringify(key)} to both ${held} and ${who}`,
        );
      }
      identities[key] = who;
    };

    for (const [who, value] of Object.entries(raw.people as Record<string, unknown>)) {
      // A plain string stays what it always was: one line about a person. An
      // object adds the identities a message can arrive under.
      const entry =
        typeof value === "string"
          ? { about: value }
          : ((value ?? {}) as { about?: unknown; numbers?: unknown; aka?: unknown });

      const line = String(entry.about ?? "").trim();
      if (line) people[who] = line;

      // The name itself, so a client that already resolved the sender properly
      // needs no mapping at all.
      claim(who.trim().toLowerCase(), who);
      for (const n of Array.isArray(entry.numbers) ? entry.numbers : []) {
        claim(String(n).replace(/\D/g, ""), who);
      }
      for (const a of Array.isArray(entry.aka) ? entry.aka : []) {
        claim(String(a).trim().toLowerCase(), who);
      }
    }

    if (Object.keys(people).length > 0) audience.people = people;
    // Kept even when nobody has an `about` line. Naming the sender is useful
    // on its own; facts about them are a separate thing to have.
    if (Object.keys(identities).length > 0) audience.identities = identities;
  }
  if (audience.voice === "custom") {
    const described = String(raw?.voicePrompt ?? "").trim();
    if (!described) {
      throw new Error(`config: audiences.${name}.voice is "custom", so voicePrompt must describe how it should talk`);
    }
    audience.voicePrompt = described;
  }

  // The combination that turns the assistant into a fabricator: nothing to read
  // and licence to answer anyway. Legal for a banter-only group, so it is a
  // warning rather than an error, but it should never be arrived at silently.
  if (audience.onNoMatch === "just-talk" && audience.view !== "none") {
    console.error(
      `config: audiences.${name} answers even when nothing was found, while also being able to read ${audience.view}. ` +
        `That mixes grounded and ungrounded answers in one chat, and a reader cannot tell which they got.`,
    );
  }
  return audience;
}

/**
 * The ceiling on retrieved chunks, matching the one `src/mcp.ts` has always
 * clamped its own tool argument to. Twenty-five excerpts is already more
 * material than a question needs.
 */
export const MAX_ASK_CHUNKS = 25;

/**
 * Chunks per answer, clamped rather than refused.
 *
 * Its sibling `askMaxTokens` throws and this deliberately does not. Nothing
 * bounded this at all - the line was `Number(raw.ask.maxChunks ?? 8)`, which
 * took 500 without comment, and at roughly 400 characters an excerpt that is
 * ~200KB of retrieved input on every question. The output cap next door had a
 * validator; the input side had nothing, which is the half of #22 that was
 * still open.
 *
 * Clamped because a config that loads today has to keep loading: throwing
 * would turn a working install into one that will not boot on the next
 * restart, to prevent a bill rather than a wrong answer. Loud on stderr,
 * because silently ignoring a number somebody typed on purpose is how they
 * conclude the setting does nothing.
 */
function askMaxChunks(value: unknown): number {
  const asked = Math.floor(Number(value));
  if (!Number.isFinite(asked) || asked < 1) {
    console.error(
      `config: ask.maxChunks must be a positive whole number, got ${JSON.stringify(value)}. Using 8.`,
    );
    return 8;
  }
  if (asked > MAX_ASK_CHUNKS) {
    console.error(
      `config: ask.maxChunks ${asked} is above the ceiling of ${MAX_ASK_CHUNKS}, so ${MAX_ASK_CHUNKS} is being used. ` +
        `Each excerpt is capped at about 400 characters, so ${asked} of them is roughly ` +
        `${Math.round((asked * 400) / 1000)}KB of input on every question.`,
    );
    return MAX_ASK_CHUNKS;
  }
  return asked;
}

function askMaxTokens(value: unknown): number {
  const tokens = Number(value);
  if (!Number.isInteger(tokens) || tokens < 1) {
    throw new Error(`config: ask.maxTokens must be a positive whole number, got ${JSON.stringify(value)}`);
  }
  return tokens;
}

export function loadConfig(path = defaultConfigPath()): Config {
  if (!existsSync(path)) {
    throw new Error(`no config at ${path}\n  cp tama.config.example.json tama.config.json\n  then set vault.path and server.adminToken`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const home = process.env.HOME ?? "~";
  const expand = (p: string) => resolve(p.replace(/^~/, home));
  const credential = (section: any, name = "apiKey", fallback?: string): string | undefined => {
    const file = section?.[`${name}File`];
    const env = section?.[`${name}Env`];
    const value = file
      ? readFileSync(resolve(dirname(path), String(file)), "utf8")
      : env
        ? process.env[String(env)]
        : section?.[name] ?? (fallback ? process.env[fallback] : undefined);
    const clean = value === undefined || value === null ? "" : String(value).trim();
    return clean || undefined;
  };

  if (!raw?.vault?.path) throw new Error("config: vault.path is required");
  if (!raw?.server?.adminToken || String(raw.server.adminToken).includes("openssl")) {
    throw new Error("config: server.adminToken is required. generate one: openssl rand -hex 24");
  }

  const provider = raw.notify?.provider ?? "console";
  if (provider === "ntfy" && !raw.notify?.ntfy?.topic) {
    throw new Error("config: notify.ntfy.topic is required when provider is ntfy");
  }

  // stt.provider selects a wire format, so an unrecognized value has to fail
  // here and not as an opaque 404 on the first capture of the day.
  const sttProvider = raw.stt?.provider ?? "whisper-cpp";
  if (sttProvider !== "whisper-cpp" && sttProvider !== "openai-compatible" && sttProvider !== "sarvam") {
    throw new Error(`config: stt.provider must be "whisper-cpp", "openai-compatible" or "sarvam", got ${JSON.stringify(sttProvider)}`);
  }
  // Sarvam serves a default model and whisper.cpp serves whatever it was
  // started with; only the OpenAI shape genuinely cannot guess.
  if (sttProvider === "openai-compatible" && !raw.stt?.model) {
    throw new Error("config: stt.model is required for the openai-compatible provider (e.g. whisper-large-v3)");
  }
  if (sttProvider === "sarvam" && !credential(raw.stt)) {
    throw new Error("config: sarvam needs an API key. set stt.apiKey, stt.apiKeyEnv or stt.apiKeyFile");
  }

  // Absent `ask` is the normal case, not an error. Only validate once someone
  // has opted in, and then fail loudly rather than at the first question.
  let ask: Config["ask"];
  if (raw.ask) {
    const provider = raw.ask.provider;
    if (provider !== "anthropic" && provider !== "openai-compatible") {
      throw new Error(`config: ask.provider must be "anthropic" or "openai-compatible", got ${JSON.stringify(provider)}`);
    }
    if (!raw.ask.model) throw new Error("config: ask.model is required when ask is set");
    if (provider === "openai-compatible" && !raw.ask.baseUrl) {
      throw new Error("config: ask.baseUrl is required for the openai-compatible provider (e.g. http://127.0.0.1:11434/v1)");
    }
    // The key may legitimately live in the environment instead of the config
    // file, which is the better place for a secret, so its absence here is not
    // an error. A local llama.cpp or Ollama needs no key at all.
    ask = {
      provider,
      model: String(raw.ask.model),
      apiKey: credential(raw.ask, "apiKey", provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"),
      baseUrl: raw.ask.baseUrl,
      maxChunks: askMaxChunks(raw.ask.maxChunks ?? 8),
      ...(raw.ask.maxTokens === undefined ? {} : { maxTokens: askMaxTokens(raw.ask.maxTokens) }),
    };
  }

  // Absent `route` is the old behaviour exactly: captures stay in the Inbox and
  // no note is ever rewritten. Turning it on is a decision about somebody's
  // notes, so it is never a default.
  let route: Config["route"];
  if (raw.route) {
    const num = (value: unknown, fallback: number, name: string): number => {
      if (value === undefined) return fallback;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`config: route.${name} must be a non-negative number, got ${JSON.stringify(value)}`);
      }
      return n;
    };

    // now.md is rewritten whole every cycle, so it has to be one file at the
    // vault root and not, say, a folder that a typo would turn into one.
    const nowNote = String(raw.route.nowNote ?? ROUTE_DEFAULTS.nowNote);
    if (!nowNote.toLowerCase().endsWith(".md") || nowNote.includes("/") || nowNote.startsWith(".")) {
      throw new Error(`config: route.nowNote must be a Markdown file at the vault root, got ${JSON.stringify(nowNote)}`);
    }
    const minConfidence = num(raw.route.minConfidence, ROUTE_DEFAULTS.minConfidence, "minConfidence");
    if (minConfidence > 1) {
      throw new Error(`config: route.minConfidence is a probability between 0 and 1, got ${JSON.stringify(raw.route.minConfidence)}`);
    }

    route = {
      enabled: raw.route.enabled !== false,
      everyMinutes: num(raw.route.everyMinutes, ROUTE_DEFAULTS.everyMinutes, "everyMinutes"),
      minAgeSeconds: num(raw.route.minAgeSeconds, ROUTE_DEFAULTS.minAgeSeconds, "minAgeSeconds"),
      maxPerSweep: num(raw.route.maxPerSweep, ROUTE_DEFAULTS.maxPerSweep, "maxPerSweep"),
      minConfidence,
      maxTries: num(raw.route.maxTries, ROUTE_DEFAULTS.maxTries, "maxTries"),
      nowNote,
    };
    // Loudly, at load, rather than as a cycle that quietly does nothing every
    // fifteen minutes for a week.
    if (route.enabled && !ask) {
      throw new Error("config: route needs an ask block. Filing a capture means deciding where it belongs, which needs the model");
    }
    if (route.everyMinutes < 1) {
      throw new Error("config: route.everyMinutes must be at least 1");
    }
  }

  const rawViews = (raw.views ?? {}) as Record<string, unknown>;
  const views: Record<string, View> = {};
  for (const [name, raw] of Object.entries(rawViews)) {
    if (name in BUILTIN_VIEWS) {
      throw new Error(`config: views.${name} would shadow a built-in view. rename it`);
    }
    const include = (raw as any)?.include;
    const exclude = (raw as any)?.exclude;
    for (const [field, value] of [["include", include], ["exclude", exclude]] as const) {
      if (value !== undefined && (!Array.isArray(value) || value.some((g) => typeof g !== "string"))) {
        throw new Error(`config: views.${name}.${field} must be a list of path patterns`);
      }
    }
    views[name] = { ...(include === undefined ? {} : { include }), ...(exclude === undefined ? {} : { exclude }) };
  }

  const audiences: Record<string, Audience> = {};
  for (const [name, entry] of Object.entries((raw.audiences ?? {}) as Record<string, unknown>)) {
    audiences[name] = parseAudience(name, entry, views);
  }

  let whatsapp: Config["whatsapp"];
  if (raw.whatsapp) {
    const phoneNumberId = String(raw.whatsapp.phoneNumberId ?? "").trim();
    if (!/^\d+$/.test(phoneNumberId)) throw new Error("config: whatsapp.phoneNumberId is required and must contain digits only");

    if (!Array.isArray(raw.whatsapp.allowedFrom) || raw.whatsapp.allowedFrom.length === 0) {
      throw new Error("config: whatsapp.allowedFrom must list at least one sender in international format");
    }
    const allowedFrom: string[] = [...new Set<string>(
      (raw.whatsapp.allowedFrom as unknown[]).map((value) => String(value).trim().replace(/^\+/, "")),
    )];
    if (allowedFrom.some((value) => !/^\d{6,20}$/.test(value))) {
      throw new Error("config: whatsapp.allowedFrom entries must be international numbers containing digits only");
    }

    const accessToken = credential(raw.whatsapp, "accessToken");
    const appSecret = credential(raw.whatsapp, "appSecret");
    const verifyToken = credential(raw.whatsapp, "verifyToken");
    if (!accessToken) throw new Error("config: whatsapp access token is required (accessTokenEnv or accessTokenFile)");
    if (!appSecret) throw new Error("config: whatsapp app secret is required (appSecretEnv or appSecretFile)");
    if (!verifyToken) throw new Error("config: whatsapp verify token is required (verifyTokenEnv or verifyTokenFile)");

    const graphApiVersion = String(raw.whatsapp.graphApiVersion ?? "v23.0").trim();
    if (!/^v\d+\.\d+$/.test(graphApiVersion)) {
      throw new Error("config: whatsapp.graphApiVersion must look like v23.0");
    }
    let publicBaseUrl: string | undefined;
    if (raw.whatsapp.publicBaseUrl) {
      try {
        const url = new URL(String(raw.whatsapp.publicBaseUrl));
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
        publicBaseUrl = url.origin;
      } catch {
        throw new Error("config: whatsapp.publicBaseUrl must be a public https:// origin without credentials, query, or fragment");
      }
    }
    whatsapp = {
      phoneNumberId,
      allowedFrom,
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
      accessToken,
      appSecret,
      verifyToken,
      graphApiVersion,
    };
  }

  return {
    vault: { path: expand(raw.vault.path), inbox: raw.vault.inbox ?? "Inbox" },
    ask,
    route,
    whatsapp,
    ...(raw.world?.name ? { world: { name: String(raw.world.name) } } : {}),
    views,
    audiences,
    stt: {
      provider: sttProvider,
      // `baseUrl` is what the ask block calls the same thing, so accept either.
      url: raw.stt?.baseUrl ?? raw.stt?.url ?? (sttProvider === "sarvam" ? SARVAM_URL : "http://127.0.0.1:8081"),
      model: raw.stt?.model ? String(raw.stt.model) : undefined,
      language: raw.stt?.language ? String(raw.stt.language) : undefined,
      apiKey: credential(raw.stt),
    },
    server: { port: raw.server?.port ?? 8080, adminToken: String(raw.server.adminToken) },
    notify: {
      provider,
      ntfy: {
        url: raw.notify?.ntfy?.url ?? "https://ntfy.sh",
        topic: raw.notify?.ntfy?.topic ?? "",
        token: raw.notify?.ntfy?.token,
      },
      digestAt: raw.notify?.digestAt ?? "08:00",
    },
    safety: {
      allowUnbackedVault: raw.safety?.allowUnbackedVault ?? false,
      dryRun: raw.safety?.dryRun ?? false,
    },
    dataDir: expand(raw.dataDir ?? "./data"),
  };
}
