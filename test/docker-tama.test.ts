/**
 * The Docker wrapper, where `bun test` has never reached.
 *
 * `docker/tama` writes `.env`, writes a root-owned config, starts containers
 * and rolls all three back. The rollback branches are the code least likely to
 * ever run and most likely to be wrong, and until now nothing tested any of it.
 *
 * These do not need Docker. Two kinds of check:
 *
 * 1. Functions extracted from the real file and driven under `sh`, so the thing
 *    under test is the thing that ships rather than a copy.
 * 2. Structural assertions about orderings whose violation is unrecoverable on
 *    a live box - the sort of thing a reviewer catches once and then nothing
 *    remembers.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "..");
const wrapper = await Bun.file(join(root, "docker/tama")).text();

/** Pull one shell function out of the shipped file, by name. */
function shellFunction(name: string): string {
  const start = wrapper.indexOf(`${name}() {`);
  expect(start, `${name}() not found in docker/tama`).toBeGreaterThan(-1);
  const end = wrapper.indexOf("\n}", start);
  return wrapper.slice(start, end + 2);
}

async function runSh(script: string, arg: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tama-sh-"));
  try {
    const path = join(dir, "probe.sh");
    await writeFile(path, script);
    const proc = Bun.spawn(["sh", path, arg], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the wrapper is valid POSIX sh", async () => {
  // It has a #!/bin/sh shebang, so a bashism is a syntax error on a Debian box
  // and nowhere else. `sh -n` is the cheapest possible guard against that.
  const proc = Bun.spawn(["sh", "-n", join(root, "docker/tama")], { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited, err).toBe(0);
});

test("valid_domain accepts real hostnames and refuses what no CA will issue for", async () => {
  const script = `${shellFunction("valid_domain")}\nvalid_domain "$1" && echo yes || echo no\n`;

  for (const good of ["tama.example.com", "sub.domain.co.uk", "a-b.example.com", "xn--p1ai.example.com"]) {
    expect(await runSh(script, good), good).toBe("yes");
  }

  // Each of these produces a Caddy site address that will never get a
  // certificate, and the failure otherwise arrives minutes later as an ACME
  // error rather than immediately as a typo.
  for (const bad of [
    "203.0.113.10",   // a bare IPv4
    "1.2.3.4",
    "box.local",      // reserved suffixes
    "tama.internal",
    "host.lan",
    "localhost",
    "example",        // single label
    "",
    "under_score.com",
    "-lead.com",
    "trail-.com",     // hyphen at the edge of an inner label
    "a..b.com",
    "a b.com",
  ]) {
    expect(await runSh(script, bad), bad || "<empty>").toBe("no");
  }
});

test("http_code answers 000 once, not 000000, when nothing is listening", async () => {
  // `curl ... || echo 000` is the obvious spelling and it is wrong: curl writes
  // its own 000 through -w AND exits non-zero, so the fallback appends. The
  // status is printed to the operator, so 000000 is a number they then try to
  // look up.
  const script = `${shellFunction("http_code")}\nhttp_code "$1" 2\n`;
  // Port 9 is discard; nothing serves HTTP there.
  expect(await runSh(script, "http://127.0.0.1:9/health")).toBe("000");
});

test("public_domain reads the last TAMA_DOMAIN line and tolerates no .env", async () => {
  const script = `${shellFunction("public_domain")}\ncd "$1" && public_domain\n`;
  const dir = await mkdtemp(join(tmpdir(), "tama-env-"));
  try {
    // No .env at all is the ordinary tailnet install, and must not error.
    expect(await runSh(script, dir)).toBe("");

    // Last wins, matching how the file is written: delete-then-append, because
    // a second line for the same key wins silently in Compose too.
    await writeFile(join(dir, ".env"), "TAMA_VAULT_DIR=/vault\nTAMA_DOMAIN=old.example.com\nTAMA_DOMAIN=new.example.com\n");
    expect(await runSh(script, dir)).toBe("new.example.com");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the two .env keys are only ever written together and deleted together", () => {
  // COMPOSE_FILE naming the overlay while TAMA_DOMAIN is absent aborts EVERY
  // compose command on the machine with "required variable TAMA_DOMAIN is
  // missing a value" - so `tama logs` and `tama status` stop working and cannot
  // report why. Either key alone is a broken box.
  const deletes = wrapper.match(/sed -i '[^']*TAMA_DOMAIN=[^']*'/g) ?? [];
  expect(deletes.length).toBeGreaterThan(0);
  for (const d of deletes) {
    expect(d, `a sed that removes TAMA_DOMAIN must remove COMPOSE_FILE too: ${d}`).toContain("COMPOSE_FILE=");
  }
});

test("the caddy container is removed before .env is stripped", () => {
  // The one ordering that is unrecoverable through the wrapper. `compose rm`
  // has to run while COMPOSE_FILE still names the overlay; strip .env first and
  // the container is invisible to every compose command on the box while
  // `restart: unless-stopped` keeps it holding 0.0.0.0:443.
  const off = wrapper.slice(wrapper.indexOf("      --off|off)"), wrapper.indexOf("      --public|public)"));
  const rmAt = off.indexOf("compose rm -sf caddy");
  const sedAt = off.indexOf("sed -i '/^TAMA_DOMAIN=");
  expect(rmAt).toBeGreaterThan(-1);
  expect(sedAt).toBeGreaterThan(-1);
  expect(rmAt, "compose rm must come before the .env strip in --off").toBeLessThan(sedAt);
});

test("expose shifts, so a domain argument is not read as the flag name", () => {
  // `expose` never shifted, so `--public tama.example.com` put the domain in $2
  // and `${1:-}` inside the branch was the literal string "--public".
  const block = wrapper.slice(wrapper.indexOf("  expose)"), wrapper.indexOf("      status)"));
  expect(block).toContain("shift");
});

test("the certificate probe pins the domain to loopback", () => {
  // A plain `curl https://$domain/health` returns 000 on a working cloud
  // deployment, because an instance cannot reach its own public address through
  // the gateway in front of it - so the command would report failure at the
  // moment of success. --resolve tests the certificate, the SNI match and the
  // proxy to tama, which is what this script is actually responsible for.
  expect(shellFunction("cert_code")).toContain("--resolve");
});

test("optional services are opt-in, not built into every command", () => {
  // docker-compose.yml puts the WhatsApp bridge behind `profiles:` so an
  // install that does not want it does not run it. The wrapper used to pass
  // `--profile whatsapp-webjs` on every single command, which meant every
  // install ran it regardless.
  //
  // The cost is not abstract: clients/whatsapp-webjs/Dockerfile installs
  // Chromium, because whatsapp-web.js drives a real browser. An install that
  // never touched WhatsApp was building a browser on every restart and keeping
  // one resident.
  expect(wrapper).toContain("compose() { docker compose \"$@\"; }");
  expect(wrapper, "compose() must not hardcode a profile").not.toMatch(/compose\(\) \{ docker compose --profile/);

  // The hazard the old comment named is real - a service missing from the
  // loaded model is an orphan Compose will stop - so an existing deployment
  // has to keep what it already runs.
  const fn = shellFunction("ensure_profiles");
  expect(fn).toContain("COMPOSE_PROFILES");
  // Derived from configuration AND from what is already running, so a bridge
  // set up through .env rather than the wizard is not orphaned either.
  expect(fn).toContain("config/whatsapp-bridge.json");
  expect(fn).toContain("docker ps -aq --filter name=whatsapp-webjs");
  // Written only when there is something to carry: an install with neither
  // gets no line, and self-heals if WhatsApp is configured later.
  expect(fn).toContain('if [ -n "$want" ]');
});
