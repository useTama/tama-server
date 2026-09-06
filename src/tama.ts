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
  console.log("tama-server [--config PATH] | tama-server setup");
} else {
  await import("./index.ts");
}
