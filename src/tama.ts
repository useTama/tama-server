export {};

const command = Bun.argv[2];

if (command === "setup") {
  const { runSetup } = await import("./setup.ts");
  try { await runSetup(); }
  catch (error) {
    console.error(`Setup: ${error instanceof Error ? error.message : "could not complete setup"}`);
    process.exitCode = 1;
  }
} else if (command === "help" || command === "--help" || command === "-h") {
  const { tama, grey } = await import("./ui.ts");
  console.log(`${tama("tama-server")} [--config PATH] ${grey("run the server")}`);
  console.log(`${tama("tama-server")} setup             ${grey("configure a vault, transcription, and Ask")}`);
  console.log(grey("\nColour follows NO_COLOR and is dropped when output is not a terminal."));
} else {
  await import("./index.ts");
}
