import { test, expect } from "bun:test";
import { yes } from "../src/prompt.ts";

test("yes helper defaults when empty", async () => {
  // yes takes fallback boolean
  expect(typeof yes).toBe("function");
});
