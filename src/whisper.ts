/**
 * Bringing whisper.cpp up on this machine.
 *
 * Setup used to stop at "start Whisper on your server, then enter its address",
 * which left the hardest three steps — install a binary, find a model that is
 * half a gigabyte, keep a process alive across reboots — outside the guided
 * flow entirely. Everything here is the mechanics of doing that; the wizard
 * owns the questions, so this module never prompts and never prints.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const MODEL_DIR = join(homedir(), ".local/share/whisper");

/**
 * The two the README already recommends. Bigger models exist and want a real
 * GPU, which is not a thing a first-run wizard should quietly commit someone to.
 */
export const MODELS = [
  { value: "ggml-small.bin", label: "small — 488 MB, good on any laptop or small server" },
  { value: "ggml-base.bin", label: "base — 148 MB, for a Raspberry Pi or a 1 GB box" },
];

export const modelUrl = (file: string): string =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;

/** whisper.cpp's HTTP server, under the names the common packages ship it as. */
export const serverBinary = (): string | null =>
  Bun.which("whisper-server") ?? Bun.which("whisper.cpp-server") ?? Bun.which("whisper-cpp-server");

export const installHint = (): string =>
  platform() === "darwin"
    ? "brew install whisper-cpp"
    : "apt install whisper-cpp, or build it: https://github.com/ggml-org/whisper.cpp#quick-start";

export async function installedModels(): Promise<string[]> {
  if (!existsSync(MODEL_DIR)) return [];
  return (await readdir(MODEL_DIR)).filter((f) => f.endsWith(".bin")).sort();
}

/**
 * Downloads to a temp name and renames on success. A half-finished model that
 * looks like a finished one is worse than no model: whisper loads it, fails
 * somewhere deep, and the wizard's reachability check still says everything is
 * fine. Ctrl+C during the download leaves nothing behind.
 */
export async function downloadModel(file: string, onProgress: (fraction: number) => void): Promise<string> {
  await mkdir(MODEL_DIR, { recursive: true });
  const target = join(MODEL_DIR, file);
  const partial = `${target}.${crypto.randomUUID()}.part`;
  try {
    const response = await fetch(modelUrl(file), { signal: AbortSignal.timeout(3_600_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length") ?? 0);
    const sink = Bun.file(partial).writer();
    const reader = response.body.getReader();
    let done = 0;
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      sink.write(value);
      done += value.byteLength;
      if (total > 0) onProgress(done / total);
    }
    await sink.end();
    await rename(partial, target);
    return target;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

export type Service = {
  /** Where the unit file goes. */
  path: string;
  contents: string;
  /** Run this to start it now and at every login. */
  load: string[];
  /** How the owner stops it again, for the line setup prints. */
  stop: string;
};

/**
 * A per-user service, not a system one. Setup runs as whoever owns the vault
 * and must not need root, and a transcription server with no model of its own
 * has no business outliving the account that configured it.
 */
export function serviceFor(binary: string, model: string, port: number): Service | null {
  const args = [binary, "-m", model, "--host", "127.0.0.1", "--port", String(port)];
  if (platform() === "darwin") {
    const label = "com.usetama.whisper";
    return {
      path: join(homedir(), "Library/LaunchAgents", `${label}.plist`),
      contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${a}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(homedir(), "Library/Logs/tama-whisper.log")}</string>
  <key>StandardErrorPath</key><string>${join(homedir(), "Library/Logs/tama-whisper.log")}</string>
</dict>
</plist>
`,
      load: ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 501}`],
      stop: `launchctl bootout gui/$(id -u)/${label}`,
    };
  }
  if (platform() === "linux") {
    return {
      path: join(homedir(), ".config/systemd/user/tama-whisper.service"),
      contents: `[Unit]
Description=whisper.cpp server for Tama

[Service]
ExecStart=${args.join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
      load: ["systemctl", "--user", "enable", "--now", "tama-whisper.service"],
      stop: "systemctl --user disable --now tama-whisper.service",
    };
  }
  return null;
}

/** Writes the unit and runs its loader. Returns the loader's stderr on failure. */
export async function installService(service: Service): Promise<string | null> {
  await mkdir(join(service.path, ".."), { recursive: true });
  await writeFile(service.path, service.contents, { mode: 0o644 });
  // launchctl bootstrap takes the plist path as its final argument; systemctl
  // takes the unit name, which is already in `load`.
  const argv = service.load[0] === "launchctl" ? [...service.load, service.path] : service.load;
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  if ((await child.exited) === 0) return null;
  return (await new Response(child.stderr).text()).trim() || `${argv[0]} exited non-zero`;
}

/** Polls until the server answers, because a freshly loaded service is not instantly up. */
export async function waitForHealth(check: () => Promise<boolean>, seconds = 30): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return true;
    await Bun.sleep(1000);
  }
  return false;
}
