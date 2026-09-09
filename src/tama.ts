export {};

const command = Bun.argv[2];

if (command === "setup") {
  const { runSetup } = await import("./setup.ts");
  try { await runSetup(Bun.argv); }
  catch (error) {
    console.error(`Setup: ${error instanceof Error ? error.message : "could not complete setup"}`);
    process.exitCode = 1;
  }
} else if (command === "settings") {
  const { runSettings } = await import("./settings.ts");
  try { await runSettings(Bun.argv); }
  catch (error) {
    console.error(`Settings: ${error instanceof Error ? error.message : "could not open settings"}`);
    process.exitCode = 1;
  }
} else if (command === "token") {
  const { runToken } = await import("./token-cli.ts");
  try { await runToken(Bun.argv); }
  catch (error) {
    console.error(`Token: ${error instanceof Error ? error.message : "could not mint a token"}`);
    process.exitCode = 1;
  }
} else if (command === "connect" || command === "mcp") {
  const { runConnect } = await import("./connect-cli.ts");
  try { await runConnect(Bun.argv); }
  catch (error) {
    console.error(`Connect: ${error instanceof Error ? error.message : "could not prepare a client"}`);
    process.exitCode = 1;
  }
} else if (command === "session") {
  const { runSession } = await import("./session-cli.ts");
  try { await runSession(Bun.argv); }
  catch (error) {
    console.error(`Session: ${error instanceof Error ? error.message : "could not record the session"}`);
    process.exitCode = 1;
  }
} else if (command === "route") {
  const { runRoute } = await import("./route-cli.ts");
  try { await runRoute(Bun.argv); }
  catch (error) {
    console.error(`Route: ${error instanceof Error ? error.message : "could not file the Inbox"}`);
    process.exitCode = 1;
  }
} else if (command === "import") {
  const { runImport } = await import("./import.ts");
  try { await runImport(Bun.argv); }
  catch (error) {
    console.error(`Import: ${error instanceof Error ? error.message : "could not import notes"}`);
    process.exitCode = 1;
  }
} else if (command === "help" || command === "--help" || command === "-h") {
  const { tama, grey, bold, divider } = await import("./ui.ts");
  const { logo } = await import("./logo.ts");
  console.log(logo());
  console.log(`  ${tama("tama-server")} ${grey("— voice notes in a markdown vault you own.")}`);
  console.log(`  ${divider(56)}\n`);
  console.log(`  ${bold("USAGE")}:`);
  console.log(`    tama-server [command] [options]\n`);
  console.log(`  ${bold("COMMANDS")}:`);
  console.log(`    ${tama("tama-server")}                     ${grey("run the capture & query server")}`);
  console.log(`    ${tama("tama-server")} setup               ${grey("configure vault, speech-to-text, Ask, and WhatsApp")}`);
  console.log(`    ${tama("tama-server")} settings            ${grey("change WhatsApp numbers, devices, or re-run setup")}`);
  console.log(`    ${tama("tama-server")} token NAME          ${grey("mint a device token for a client")}`);
  console.log(`    ${tama("tama-server")} connect [client]    ${grey("install line for claude-code / claude-desktop")}`);
  console.log(`    ${tama("tama-server")} session PROJECT     ${grey("record what a work session did; body on stdin")}`);
  console.log(`    ${tama("tama-server")} import FOLDER       ${grey("copy existing Markdown into the configured vault")}`);
  console.log(`    ${tama("tama-server")} route               ${grey("file what is waiting in the Inbox, now")}\n`);
  console.log(`  ${bold("OPTIONS")}:`);
  console.log(`    ${grey("--config PATH")}                  ${grey("path to config file (default: tama.config.json)")}`);
  console.log(`    ${grey("--dry-run")}                      ${grey("preview route changes without writing to vault")}`);
  console.log(`    ${grey("--as AUDIENCE")}                  ${grey("mint token scoped to a specific audience")}`);
  console.log(`    ${grey("--help, -h")}                     ${grey("show this help message")}\n`);
  console.log(`  ${grey("Colour follows NO_COLOR and is dropped when output is not a terminal.")}`);
} else {
  await import("./index.ts");
}
