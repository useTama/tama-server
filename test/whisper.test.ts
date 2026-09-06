import { test, expect } from "bun:test";
import { MODELS, modelUrl, serviceFor } from "../src/whisper.ts";

test("the offered models are the two the docs recommend, smallest last", () => {
  expect(MODELS.map((m) => m.value)).toEqual(["ggml-small.bin", "ggml-base.bin"]);
  expect(modelUrl("ggml-base.bin")).toBe("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin");
});

test("the generated service runs the chosen binary, model and port", () => {
  const service = serviceFor("/usr/local/bin/whisper-server", "/models/ggml-base.bin", 9001);
  // Only macOS and Linux get a template; elsewhere setup prints the command.
  expect(service).not.toBeNull();
  expect(service!.contents).toContain("/usr/local/bin/whisper-server");
  expect(service!.contents).toContain("/models/ggml-base.bin");
  expect(service!.contents).toContain("9001");
  expect(service!.contents).toContain("127.0.0.1");
  expect(service!.path).toMatch(/LaunchAgents|systemd\/user/);
  // It has to be a per-user unit: setup never asks for root.
  expect(service!.path.startsWith(process.env.HOME!)).toBe(true);
});
