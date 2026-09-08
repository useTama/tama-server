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
  const { tama, grey } = await import("./ui.ts");
  console.log(`${tama("tama-server")} [--config PATH]       ${grey("run the server")}`);
  console.log(`${tama("tama-server")} setup [--config PATH] ${grey("configure the vault, transcription, Ask, and WhatsApp")}`);
  console.log(`${tama("tama-server")} settings [--config PATH] ${grey("change WhatsApp numbers, devices, or re-run setup")}`);
  console.log(`${tama("tama-server")} token NAME [--as AUDIENCE] ${grey("mint a device token for a client")}`);
  console.log(`${tama("tama-server")} session PROJECT [--config PATH] ${grey("record what a work session did; body on stdin")}`);
  console.log(`${tama("tama-server")} import FOLDER [--config PATH] ${grey("copy existing Markdown into the configured vault")}`);
  console.log(`${tama("tama-server")} route [--dry-run] [--config PATH] ${grey("file what is waiting in the Inbox, now")}`);
  console.log(grey("\nColour follows NO_COLOR and is dropped when output is not a terminal."));
} else {
  await import("./index.ts");
}
