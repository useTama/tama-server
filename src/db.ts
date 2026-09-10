import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Server-side state: tokens, pairing codes, idempotency keys, a capture log.
 *
 * Deliberately NOT in the vault. The vault holds notes; this holds operational
 * state that is meaningless to a human reading markdown. The capture log is
 * derived (rebuildable from the write journal) but the tokens are not, which is
 * why this lives in the server's own data directory.
 */
export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id          TEXT PRIMARY KEY,
      hash        TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      last_used   TEXT,
      revoked_at  TEXT,
      -- Which audience this token speaks as. NULL is the owner: everything,
      -- unrestricted, which is what every token minted before audiences
      -- existed has to keep meaning.
      --
      -- It lives on the token rather than in the request because a client that
      -- names its own audience can name a different one. The bridge holds one
      -- token per audience; the server decides what each may see.
      audience    TEXT,

      -- What this token may do, and where. All three NULL is the owner's own
      -- device: every capability, no path constraint. See src/grants.ts for why
      -- these are separate from the audience column rather than derived from it.
      --
      -- caps is a comma-separated subset of capture,read,write,ask. The two
      -- view columns hold view NAMES; views.ts owns what they mean, so the same
      -- subset is not spelled out again per token.
      caps        TEXT,
      read_view   TEXT,
      write_view  TEXT
    );

    -- An authorization request parked between /oauth/authorize and the owner
    -- consenting, then between consent and the code being exchanged.
    --
    -- Parked here rather than carried through the consent page as hidden form
    -- fields: the POST reads redirect_uri, code_challenge, state and resource
    -- back from this row, so there is nothing for a caller to tamper with and
    -- no re-validation for a later refactor to drop.
    CREATE TABLE IF NOT EXISTS oauth_requests (
      id            TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      client_name   TEXT NOT NULL,
      redirect_uri  TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      state         TEXT,
      -- RFC 8707. Bound into the issued token and checked on every request, so
      -- a token minted for this server cannot be replayed at another.
      resource      TEXT,
      scope         TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      -- Set when the owner consents; the row becomes the pending code.
      consumed_at   TEXT,
      code_hash     TEXT,
      granted_scope TEXT
    );

    CREATE TABLE IF NOT EXISTS pairing_codes (
      code       TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      attempts   INTEGER NOT NULL DEFAULT 0,
      locked_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS pairing_attempts (
      caller     TEXT PRIMARY KEY,
      attempts   INTEGER NOT NULL,
      window_at  TEXT NOT NULL,
      locked_at  TEXT
    );

    -- Idempotency: a client retrying a timed-out request must not create a
    -- second note. The UNIQUE key is what makes the race safe.
    CREATE TABLE IF NOT EXISTS idempotency (
      device_id  TEXT NOT NULL,
      key        TEXT NOT NULL,
      status     TEXT NOT NULL,          -- 'pending' | 'done'
      response   TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (device_id, key)
    );

    -- Feeds the daily digest. Derived data, safe to delete.
    CREATE TABLE IF NOT EXISTS captures (
      id           TEXT PRIMARY KEY,
      captured_at  TEXT NOT NULL,
      received_at  TEXT NOT NULL,
      note_path    TEXT NOT NULL,
      words        INTEGER NOT NULL,
      audio_secs   REAL NOT NULL,
      source       TEXT NOT NULL
    );

    -- What the routing cycle has already tried and failed to file. Working
    -- state, not vault content: the decision lives in the notes, and a capture
    -- that no model can place must stop being billed for after a few goes.
    -- Safe to delete; the worst case is one extra attempt per capture.
    CREATE TABLE IF NOT EXISTS route_attempts (
      rel_path TEXT PRIMARY KEY,
      tries    INTEGER NOT NULL DEFAULT 0,
      last_at  TEXT NOT NULL,
      last_why TEXT
    );

    CREATE TABLE IF NOT EXISTS failures (
      id         TEXT PRIMARY KEY,
      at         TEXT NOT NULL,
      kind       TEXT NOT NULL,
      detail     TEXT NOT NULL,
      source     TEXT
    );

    -- What was said in a conversation, so a follow-up means something.
    --
    -- Kept here rather than in the vault deliberately. In a group these are
    -- other people's messages: they are working state for answering the next
    -- one, not notes the owner wrote, and they must never end up in a search
    -- result. Folded into a summary and deleted as they age.
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      thread  TEXT NOT NULL,
      role    TEXT NOT NULL,          -- 'user' | 'assistant'
      speaker TEXT,                   -- who said it, in a room with several people
      text    TEXT NOT NULL,
      at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversation_turns_thread ON conversation_turns(thread, id);

    -- Everything older than the kept turns, in a paragraph.
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      thread     TEXT PRIMARY KEY,
      summary    TEXT NOT NULL,
      through_id INTEGER NOT NULL,    -- the last turn folded in
      updated_at TEXT NOT NULL
    );

    -- WhatsApp acknowledges webhooks before slow local transcription starts.
    -- Persisting the small inbound envelope makes that acknowledgement honest:
    -- a restart cannot silently forget an accepted voice note or question.
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id              TEXT PRIMARY KEY,
      sender          TEXT NOT NULL,
      kind            TEXT NOT NULL,          -- 'audio' | 'text'
      payload         TEXT NOT NULL,
      reply           TEXT,
      status          TEXT NOT NULL,          -- 'pending' | 'processing' | 'done'
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error      TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    -- What a question retrieved, kept just long enough for the owner to say
    -- the answer was wrong.
    --
    -- The server holds this rather than the client echoing it back: an
    -- audience with cite:false is never told the paths, which is the point of
    -- that setting, so a client cannot report what it was not given.
    --
    -- Derived and disposable. Losing it costs the ability to file a complaint
    -- about an answer already given.
    CREATE TABLE IF NOT EXISTS asks (
      id       TEXT PRIMARY KEY,
      thread   TEXT NOT NULL,
      question TEXT NOT NULL,
      sources  TEXT NOT NULL,          -- JSON [{path, score}]
      at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS asks_thread ON asks(thread, at);

    -- Dates a note's text talks about, as opposed to when it was captured.
    --
    -- Derived and rebuildable by re-reading the vault, so it is safe to delete,
    -- and deliberately not in the vault itself: captures are append-only and
    -- never edited, so an extraction that improves later must not need to
    -- rewrite a note somebody already trusts.
    --
    -- The precision column records how much of the date the note actually
    -- said. 'month' means the day is ours, and nothing may show it as a day.
    CREATE TABLE IF NOT EXISTS note_dates (
      note_path TEXT NOT NULL,
      at        TEXT NOT NULL,          -- 'YYYY-MM-DD', local
      precision TEXT NOT NULL,          -- 'day' | 'month'
      text      TEXT NOT NULL,          -- what the note said, for quoting back
      PRIMARY KEY (note_path, at, precision)
    );
    CREATE INDEX IF NOT EXISTS note_dates_at ON note_dates(at);

    -- A per-sender ceiling, so one person cannot spend the owner's model
    -- budget or fill their vault. The notified column is why a sender past the
    -- limit is told once and then met with silence: replying to every message
    -- past the ceiling is the amplification, not the mitigation. The dropped
    -- column exists so "the bot ignored me" is distinguishable from a bug.
    --
    -- subject is a pseudonym, never a phone number. See whatsappSource.
    CREATE TABLE IF NOT EXISTS rate_limits (
      scope     TEXT NOT NULL,           -- 'whatsapp:audio' | 'whatsapp:text'
      subject   TEXT NOT NULL,
      window_at TEXT NOT NULL,
      used      INTEGER NOT NULL,
      notified  INTEGER NOT NULL DEFAULT 0,
      dropped   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, subject)
    );

    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS captures_at  ON captures(captured_at);
    CREATE INDEX IF NOT EXISTS failures_at  ON failures(at);
    CREATE INDEX IF NOT EXISTS whatsapp_pending
      ON whatsapp_messages(status, next_attempt_at);
  `);

  // v0 databases used a global idempotency key and pairing codes without an
  // attempt counter. Migrate in place before any request can use the tables.
  const idemColumns = db.query("PRAGMA table_info(idempotency)").all() as { name: string }[];
  if (idemColumns.length && !idemColumns.some((c) => c.name === "device_id")) {
    db.exec(`
      BEGIN;
      ALTER TABLE idempotency RENAME TO idempotency_legacy;
      CREATE TABLE idempotency (
        device_id  TEXT NOT NULL,
        key        TEXT NOT NULL,
        status     TEXT NOT NULL,
        response   TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (device_id, key)
      );
      INSERT INTO idempotency (device_id, key, status, response, created_at)
        SELECT '', key, status, response, created_at FROM idempotency_legacy;
      DROP TABLE idempotency_legacy;
      COMMIT;
    `);
  }
  const pairColumns = db.query("PRAGMA table_info(pairing_codes)").all() as { name: string }[];
  if (!pairColumns.some((c) => c.name === "attempts")) {
    db.exec("ALTER TABLE pairing_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  }
  if (!pairColumns.some((c) => c.name === "locked_at")) {
    db.exec("ALTER TABLE pairing_codes ADD COLUMN locked_at TEXT");
  }
  const whatsappColumns = db.query("PRAGMA table_info(whatsapp_messages)").all() as { name: string }[];
  if (whatsappColumns.length && !whatsappColumns.some((c) => c.name === "reply")) {
    db.exec("ALTER TABLE whatsapp_messages ADD COLUMN reply TEXT");
  }

  // Added after the first releases, so an existing database needs it. Cheaper
  // and clearer than a migrations table for one additive, nullable column.
  const columns = db.query("PRAGMA table_info(tokens)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "audience")) {
    db.exec("ALTER TABLE tokens ADD COLUMN audience TEXT");
  }
  // Same shape, same reasoning: additive and nullable, so every token that
  // predates capabilities keeps meaning "the owner's own device, everything".
  //
  // The OAuth columns are on `tokens` rather than in a table of their own
  // because an OAuth grant IS a device token with an expiry and a client label.
  // That is what makes it appear in Devices, obey its Grant, and die to the
  // same revokeToken as everything else, with no second code path.
  //   expires_at   NULL for a device token, which never expires.
  //   resource     the RFC 8707 audience; NULL means "not audience-bound".
  //   client_id    which connector holds it, for the Devices list.
  //   refresh_hash the current refresh token, rotated in place on use.
  for (const name of ["caps", "read_view", "write_view", "expires_at", "resource", "client_id", "refresh_hash"]) {
    if (!columns.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE tokens ADD COLUMN ${name} TEXT`);
    }
  }

  return db;
}

export function getMeta(db: Database, k: string): string | null {
  const row = db.query("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null;
  return row?.v ?? null;
}

export function setMeta(db: Database, k: string, v: string): void {
  db.query("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}
