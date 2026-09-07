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
      revoked_at  TEXT
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

    CREATE TABLE IF NOT EXISTS failures (
      id         TEXT PRIMARY KEY,
      at         TEXT NOT NULL,
      kind       TEXT NOT NULL,
      detail     TEXT NOT NULL,
      source     TEXT
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

  return db;
}

export function getMeta(db: Database, k: string): string | null {
  const row = db.query("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null;
  return row?.v ?? null;
}

export function setMeta(db: Database, k: string, v: string): void {
  db.query("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}
