/**
 * The client manifests, checked against the server they describe.
 *
 * `clients/claude-desktop/manifest.json` and
 * `clients/claude-code/.claude-plugin/plugin.json` are shipped to strangers and
 * loaded by someone else's application, so a mistake in one is discovered at an
 * install rather than here. Three of those mistakes are mechanical, and this is
 * where they get caught:
 *
 * 1. A tool renamed in `src/mcp.ts` leaves the manifests advertising a tool that
 *    no longer exists. Nothing else compares the two lists.
 * 2. An entry point moved leaves a bundle that installs and then cannot start.
 *    `clients/claude-desktop` shipped exactly this failure once already, as a
 *    Dockerfile that copied a list of files and missed the newest one.
 * 3. `plugin.json` and the marketplace entry are two files with the same version
 *    in them, which is the kind of pair that drifts silently.
 */

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MCP_TOOL_NAMES } from "../src/mcp.ts";

const root = join(import.meta.dir, "..");
const readJson = async (rel: string) => JSON.parse(await Bun.file(join(root, rel)).text());

test("the desktop bundle advertises exactly the tools the server has", async () => {
  const manifest = await readJson("clients/claude-desktop/manifest.json");
  const advertised = (manifest.tools ?? []).map((t: { name: string }) => t.name);
  // Sorted rather than positional: the manifest orders them for a human reading
  // an install dialog, and TOOLS orders them for the model.
  expect([...advertised].sort()).toEqual([...MCP_TOOL_NAMES].sort());
});

test("the desktop bundle's entry point exists where the manifest says", async () => {
  const manifest = await readJson("clients/claude-desktop/manifest.json");
  const entry = manifest.server?.entry_point as string;
  expect(entry).toBeTruthy();
  expect(existsSync(join(root, "clients/claude-desktop", entry))).toBe(true);

  // The args line repeats the path with a ${__dirname} prefix, so it can point
  // somewhere else than entry_point does and nothing would say so.
  const args = (manifest.server?.mcp_config?.args ?? []) as string[];
  expect(args.some((a) => a.endsWith(entry))).toBe(true);
});

test("both clients ask for the two values a device needs, and mark the token sensitive", async () => {
  for (const rel of ["clients/claude-desktop/manifest.json", "clients/claude-code/.claude-plugin/plugin.json"]) {
    const manifest = await readJson(rel);
    const config = manifest.user_config ?? manifest.userConfig;
    // Both, in every client. A client that asks for only one of them cannot
    // reach a server, and one that asks for neither silently does nothing.
    expect(Object.keys(config)).toContain("server_url");
    expect(Object.keys(config)).toContain("device_token");
    // A token in a plaintext settings file is the thing both formats exist to
    // avoid, and the offer is one boolean wide.
    expect(config.device_token.sensitive).toBe(true);
    expect(config.server_url.sensitive).toBeUndefined();
  }
});

test("anything a client asks for beyond those two is optional and off", async () => {
  // A third question in an install dialog has to justify itself. The rule is
  // that only the two connection values may be required, so an extra option
  // can be added without making the install longer for someone who does not
  // want it - and a feature that spends money per session defaults to off.
  const plugin = await readJson("clients/claude-code/.claude-plugin/plugin.json");
  for (const [name, field] of Object.entries<Record<string, unknown>>(plugin.userConfig)) {
    if (name === "server_url" || name === "device_token") continue;
    expect(field.required).not.toBe(true);
    if (field.type === "boolean") expect(field.default).toBe(false);
  }
});

test("the two clients are versioned in lockstep", async () => {
  // They are released together under one `v*` tag, and
  // .github/workflows/release.yml refuses to publish if the tag and either
  // manifest disagree. Pinned here so the disagreement is caught by a test
  // run rather than by a failed release.
  //
  // The failure that earned this: the plugin gained a SessionEnd hook and a
  // new userConfig field with no version bump, so `claude plugin update`
  // answered "already at the latest version" and no install would ever have
  // picked the feature up.
  const plugin = await readJson("clients/claude-code/.claude-plugin/plugin.json");
  const bundle = await readJson("clients/claude-desktop/manifest.json");
  expect(plugin.version).toBe(bundle.version);
  expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("the marketplace entry and the plugin agree on name and source", async () => {
  const marketplace = await readJson(".claude-plugin/marketplace.json");
  const plugin = await readJson("clients/claude-code/.claude-plugin/plugin.json");

  const entry = (marketplace.plugins ?? []).find((p: { name: string }) => p.name === plugin.name);
  expect(entry).toBeTruthy();
  // `claude plugin marketplace add` clones the repo and resolves this path. A
  // stale one is a marketplace that adds cleanly and then has no plugin in it,
  // which is the error message "Plugin not found in marketplace".
  expect(existsSync(join(root, entry.source))).toBe(true);
  expect(existsSync(join(root, entry.source, ".claude-plugin/plugin.json"))).toBe(true);
});

test("the plugin points its MCP server at the configured address, not a hardcoded one", async () => {
  const mcp = await readJson("clients/claude-code/.mcp.json");
  const server = mcp.mcpServers?.tama;
  expect(server?.url).toBe("${user_config.server_url}/mcp");
  expect(server?.headers?.Authorization).toBe("Bearer ${user_config.device_token}");
});

test("the bundle keeps its tests out of the archive", async () => {
  // Shipping the tests is harmless; shipping them because nothing excludes
  // anything is how a node_modules ends up in a 200MB download.
  const ignore = await Bun.file(join(root, "clients/claude-desktop/.mcpbignore")).text();
  expect(ignore).toContain("*.test.mjs");
  expect(ignore).toContain("node_modules");
});
