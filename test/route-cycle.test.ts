import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Llm } from "../src/llm.ts";
import { Vault } from "../src/vault.ts";
import { openDb } from "../src/db.ts";
import { ROUTE_DEFAULTS, routeOnce, stuck, type RouteConfig } from "../src/route.ts";

let root: string;
let data: string;
let db: Database;

const config: RouteConfig = { ...ROUTE_DEFAULTS, minAgeSeconds: 0 };
const at = new Date("2026-09-09T00:51:12");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tama-cycle-"));
  data = await mkdtemp(join(tmpdir(), "tama-cycle-data-"));
  db = openDb(join(data, "tama.db"));
  const git = Bun.spawn(["git", "init", "-q", root], { stdout: "pipe", stderr: "pipe" });
  await git.exited;
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

/** Scripted answers, in the order the cycle asks for them. */
function stub(...answers: string[]): Llm {
  let i = 0;
  return {
    name: "stub",
    async *stream() {
      yield answers[i++] ?? "";
    },
  };
}

const triage = (o: Record<string, unknown>) => JSON.stringify({ title: "t", confidence: 0.9, openLoops: [], ...o });

async function deps(llm: Llm, vault = new Vault(root, "Inbox")) {
  return { vault, db, llm, root, inbox: "Inbox", config };
}

test("a capture is integrated into its note and vanishes from the Inbox", async () => {
  const vault = new Vault(root, "Inbox");
  await mkdir(join(root, "Projects", "remote-star"), { recursive: true });
  await writeFile(
    join(root, "Projects", "remote-star", "notes.md"),
    "## Pricing\n\nMonthly only. See [[Remote Star]].\n",
  );
  const cap = await vault.capture({ text: "client pushed back, going annual with two months free", source: "whatsapp", at });

  let wrote = 0;
  const report = await routeOnce({
    ...(await deps(
      stub(
        triage({ destination: "Projects/remote-star/notes.md", openLoops: ["send the annual quote"] }),
        "## Pricing\n\nAnnual billing, two months free, after the client pushed back. See [[Remote Star]].\n",
        "## Now\n\n- send the annual quote\n",
      ),
      vault,
    )),
    onWrite: () => wrote++,
  });

  expect(report.filed).toEqual([
    { capture: cap.relPath, destination: "Projects/remote-star/notes.md", created: false },
  ]);
  expect(report.failed).toEqual([]);
  expect(report.nowUpdated).toBe(true);
  expect(wrote).toBe(1);

  // Integrated, not appended: the old claim is gone and there is no dated section.
  const note = await readFile(join(root, "Projects/remote-star/notes.md"), "utf8");
  expect(note).toContain("Annual billing");
  expect(note).not.toContain("Monthly only");
  expect(note).toContain("[[Remote Star]]");

  // The Inbox is staging. The transcript is in git, not in a dated file.
  expect(await readdir(join(root, "Inbox"))).toHaveLength(0);
  expect(await readFile(join(root, "now.md"), "utf8")).toContain("send the annual quote");

  const log = Bun.spawnSync(["git", "-C", root, "log", "--oneline"]);
  expect(log.stdout.toString()).toContain("filed 1 capture");
});

test("a capture can start a new note under a folder that already exists", async () => {
  const vault = new Vault(root, "Inbox");
  await mkdir(join(root, "Projects"), { recursive: true });
  await writeFile(join(root, "Projects", "index.md"), "# Projects\n");
  await vault.capture({ text: "new idea for tama: parse the inbox", source: "whatsapp", at });

  const report = await routeOnce(
    await deps(
      stub(
        triage({ destination: "Projects/tama/notes.md" }),
        "# tama\n\nParse the Inbox and file each capture where it belongs.\n",
      ),
      vault,
    ),
  );

  expect(report.filed[0]).toMatchObject({ destination: "Projects/tama/notes.md", created: true });
  expect(await readFile(join(root, "Projects/tama/notes.md"), "utf8")).toContain("Parse the Inbox");
});

test("a capture nothing fits stays put, and says why", async () => {
  const vault = new Vault(root, "Inbox");
  await mkdir(join(root, "Projects"), { recursive: true });
  const cap = await vault.capture({ text: "testing one two three", source: "whatsapp", at });

  const report = await routeOnce(
    await deps(stub(triage({ destination: null, confidence: 0, reason: "a microphone test" })), vault),
  );

  expect(report.filed).toEqual([]);
  expect(report.unfiled[0]).toMatchObject({ capture: cap.relPath });
  expect(await readdir(join(root, "Inbox"))).toHaveLength(1);
});

test("low confidence leaves the capture alone rather than guessing", async () => {
  const vault = new Vault(root, "Inbox");
  await mkdir(join(root, "Projects", "remote-star"), { recursive: true });
  await writeFile(join(root, "Projects", "remote-star", "notes.md"), "## Pricing\n\nMonthly.\n");
  await vault.capture({ text: "something about billing maybe", source: "whatsapp", at });

  const report = await routeOnce(
    await deps(stub(triage({ destination: "Projects/remote-star/notes.md", confidence: 0.2 })), vault),
  );

  expect(report.filed).toEqual([]);
  expect(report.unfiled[0]!.why).toContain("below");
  expect(await readFile(join(root, "Projects/remote-star/notes.md"), "utf8")).toContain("Monthly.");
});

test("a rewrite that loses a link fails the capture instead of writing it", async () => {
  const vault = new Vault(root, "Inbox");
  await mkdir(join(root, "Projects", "remote-star"), { recursive: true });
  await writeFile(join(root, "Projects", "remote-star", "notes.md"), "## Pricing\n\nMonthly. See [[Billing]].\n");
  await vault.capture({ text: "going annual", source: "whatsapp", at });

  const report = await routeOnce(
    await deps(
      stub(triage({ destination: "Projects/remote-star/notes.md" }), "## Pricing\n\nAnnual now.\n"),
      vault,
    ),
  );

  expect(report.filed).toEqual([]);
  expect(report.failed[0]!.why).toContain("dropped links");
  // The note is untouched and the capture is still there to retry.
  expect(await readFile(join(root, "Projects/remote-star/notes.md"), "utf8")).toContain("[[Billing]]");
  expect(await readdir(join(root, "Inbox"))).toHaveLength(1);

  const failures = db.query<{ kind: string }, []>("SELECT kind FROM failures").all();
  expect(failures.map((f) => f.kind)).toContain("route-failed");
});

test("a capture is given up on after a few tries, and reported", async () => {
  const vault = new Vault(root, "Inbox");
  await mkdir(join(root, "Projects"), { recursive: true });
  const cap = await vault.capture({ text: "mmhm", source: "whatsapp", at });

  for (let i = 0; i < ROUTE_DEFAULTS.maxTries; i++) {
    await routeOnce(await deps(stub(triage({ destination: null, confidence: 0, reason: "no idea" })), vault));
  }
  expect(stuck(db, config.maxTries).map((s) => s.relPath)).toEqual([cap.relPath]);

  // And it stops costing anything: the next cycle does not even triage it.
  const report = await routeOnce(await deps(stub("this answer should never be read"), vault));
  expect(report.unfiled).toEqual([]);
  expect(report.filed).toEqual([]);
});

test("a cycle that cannot commit does not rewrite anything", async () => {
  // The whole safety model. A rewrite is reversible because the version before
  // it is in git; with no commit there is nothing to revert to.
  await rm(join(root, ".git"), { recursive: true, force: true });
  const vault = new Vault(root, "Inbox", false, true);
  await mkdir(join(root, "Projects", "remote-star"), { recursive: true });
  await writeFile(join(root, "Projects", "remote-star", "notes.md"), "## Pricing\n\nMonthly.\n");
  await vault.capture({ text: "going annual", source: "whatsapp", at });

  const report = await routeOnce(
    await deps(stub(triage({ destination: "Projects/remote-star/notes.md" }), "## Pricing\n\nAnnual.\n"), vault),
  );

  expect(report.filed).toEqual([]);
  expect(await readFile(join(root, "Projects/remote-star/notes.md"), "utf8")).toContain("Monthly.");
  expect(await readdir(join(root, "Inbox"))).toHaveLength(1);
  const kinds = db.query<{ kind: string }, []>("SELECT kind FROM failures").all().map((f) => f.kind);
  expect(kinds).toContain("route-blocked");
});

test("a full Inbox drains over several cycles rather than in one bill", async () => {
  const vault = new Vault(root, "Inbox");
  await mkdir(join(root, "Projects"), { recursive: true });
  for (let i = 0; i < 3; i++) {
    await vault.capture({ text: `thought ${i}`, source: "whatsapp", at: new Date(at.getTime() + i * 60_000) });
  }
  const small = { ...config, maxPerSweep: 2 };
  const report = await routeOnce({
    ...(await deps(stub(triage({ destination: null, confidence: 0 }), triage({ destination: null, confidence: 0 })), vault)),
    config: small,
  });
  expect(report.unfiled).toHaveLength(2);
  expect(report.remaining).toBe(1);
});

test("a dry run decides, prints and records nothing", async () => {
  // A preview that counts against maxTries would make three previews give up
  // on a capture for real, which is the one thing a preview must not do.
  const vault = new Vault(root, "Inbox", true);
  await mkdir(join(root, "Projects", "remote-star"), { recursive: true });
  await writeFile(join(root, "Projects", "remote-star", "notes.md"), "## Pricing\n\nMonthly.\n");
  const cap = await new Vault(root, "Inbox").capture({ text: "going annual", source: "whatsapp", at });

  for (let i = 0; i < ROUTE_DEFAULTS.maxTries + 1; i++) {
    await routeOnce({
      ...(await deps(stub(triage({ destination: null, confidence: 0, reason: "no idea" })), vault)),
      dryRun: true,
    });
  }

  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM route_attempts").get()!.n).toBe(0);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM failures").get()!.n).toBe(0);
  expect(stuck(db, config.maxTries)).toEqual([]);
  // And the capture is still there, unfiled, for a real pass to pick up.
  expect(await readdir(join(root, "Inbox"))).toEqual([cap.relPath.split("/")[1]!]);
});

test("a dry run leaves every note exactly as it was", async () => {
  const vault = new Vault(root, "Inbox", true);
  await mkdir(join(root, "Projects", "remote-star"), { recursive: true });
  await writeFile(join(root, "Projects", "remote-star", "notes.md"), "## Pricing\n\nMonthly.\n");
  await new Vault(root, "Inbox").capture({ text: "going annual", source: "whatsapp", at });

  const report = await routeOnce({
    ...(await deps(
      stub(
        triage({ destination: "Projects/remote-star/notes.md", openLoops: ["send the quote"] }),
        "## Pricing\n\nAnnual billing.\n",
        "## Now\n\n- send the quote\n",
      ),
      vault,
    )),
    dryRun: true,
  });

  // It still reports what it would have done, which is the point of a preview.
  expect(report.filed[0]).toMatchObject({ destination: "Projects/remote-star/notes.md" });
  expect(await readFile(join(root, "Projects/remote-star/notes.md"), "utf8")).toBe("## Pricing\n\nMonthly.\n");
  expect(await readdir(join(root, "Inbox"))).toHaveLength(1);
});
