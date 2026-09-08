import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { rawPeople } from "../src/settings.ts";

/**
 * The regression this covers is not "does it write the file" but "does the
 * screen then reflect it". Settings held one config parsed at startup, so a
 * saved audience was on disk and absent from the very next menu, which reads as
 * the save having failed.
 */
test("an audience written by one section is visible to the config on the next read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tama-settings-"));
  try {
    const path = join(dir, "tama.config.json");
    const base = {
      vault: { path: dir },
      stt: { provider: "whisper-cpp", url: "http://127.0.0.1:8081" },
      server: { adminToken: "a".repeat(48) },
    };
    await writeFile(path, JSON.stringify(base));
    expect(loadConfig(path).audiences).toEqual({});

    // What patchConfig does: read, mutate one key, write back.
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.audiences = { "315": { view: "none", voice: "roast", onNoMatch: "just-talk", mention: "when-mentioned" } };
    await writeFile(path, JSON.stringify(raw, null, 2));

    const reloaded = loadConfig(path);
    expect(Object.keys(reloaded.audiences ?? {})).toEqual(["315"]);
    expect(reloaded.audiences?.["315"]).toMatchObject({
      view: "none",
      voice: "roast",
      onNoMatch: "just-talk",
      mention: "when-mentioned",
      // Defaulted, not asked: on any view but the owner's own, a path names a
      // note to someone who was not shown it.
      cite: false,
      capture: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a patch preserves keys this version does not know about", async () => {
  // Settings owns two keys in a file the wizard also writes, so it must not
  // rewrite the document from a parsed model.
  const dir = await mkdtemp(join(tmpdir(), "tama-settings-keep-"));
  try {
    const path = join(dir, "tama.config.json");
    await writeFile(path, JSON.stringify({
      vault: { path: dir },
      stt: { provider: "whisper-cpp", url: "http://127.0.0.1:8081" },
      server: { adminToken: "a".repeat(48) },
      somethingNewerKnowsAbout: { keep: true },
    }));

    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.views = { work: { include: ["Work/**"] } };
    await writeFile(path, JSON.stringify(raw, null, 2));

    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.somethingNewerKnowsAbout).toEqual({ keep: true });
    expect(loadConfig(path).views).toEqual({ work: { include: ["Work/**"] } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- who is in the room, round-tripped ---------------------------------

/**
 * The hazard: `editAudience` replaces the whole audience when it saves, and it
 * used to seed its people editor from the parsed `Audience`, which keeps only
 * the one-line `about`. Seeding from there would drop every number the owner
 * had entered, silently and permanently, on the next settings run.
 */
test("people are read from the file, so numbers survive a settings run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tama-people-"));
  try {
    const path = join(dir, "tama.config.json");
    await writeFile(path, JSON.stringify({
      audiences: {
        crew: {
          view: "none",
          people: {
            Priya: { about: "cofounder", numbers: ["+91 98765 43210"], aka: ["Priya 🌸"] },
            Anand: "candidate we interviewed",
          },
        },
      },
    }));

    // Both shapes come back as drafts, so the editor can show and re-save
    // either without knowing which one was written.
    expect(await rawPeople(path, "crew")).toEqual({
      Priya: { about: "cofounder", numbers: ["+91 98765 43210"], aka: ["Priya 🌸"] },
      Anand: { about: "candidate we interviewed" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reading people from a missing or broken config does not block editing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tama-people-"));
  try {
    expect(await rawPeople(join(dir, "nope.json"), "crew")).toEqual({});

    const broken = join(dir, "broken.json");
    await writeFile(broken, "{ half written");
    expect(await rawPeople(broken, "crew")).toEqual({});

    const noAudience = join(dir, "empty.json");
    await writeFile(noAudience, JSON.stringify({ audiences: {} }));
    expect(await rawPeople(noAudience, "crew")).toEqual({});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
