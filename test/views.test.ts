import { test, expect } from "bun:test";
import { BUILTIN_VIEWS, partitionByView, resolveView, visible } from "../src/views.ts";

test("everything admits any path and none admits nothing", () => {
  expect(visible("Work/cpa.md", BUILTIN_VIEWS.everything)).toBe(true);
  expect(visible("Work/cpa.md", BUILTIN_VIEWS.none)).toBe(false);
});

test("an empty include list means nothing, not everything", () => {
  // The inverse reading would make `none` the most permissive view there is.
  expect(visible("anything.md", { include: [] })).toBe(false);
  expect(visible("anything.md", {})).toBe(true);
});

test("** crosses separators and matches the prefix folder itself", () => {
  const view = { include: ["Projects/**"] };
  expect(visible("Projects/tama/ai-layer.md", view)).toBe(true);
  expect(visible("Projects/CONTEXT.md", view)).toBe(true);
  expect(visible("Work/cpa.md", view)).toBe(false);
});

test("* stops at a separator", () => {
  const view = { include: ["*.md"] };
  expect(visible("Now.md", view)).toBe(true);
  expect(visible("Work/cpa.md", view)).toBe(false);
});

test("exclude beats include, which is what makes a work view usable", () => {
  const view = { include: ["KiksStudios/**"], exclude: ["**/Clients/**"] };
  expect(visible("KiksStudios/kiks-studios.md", view)).toBe(true);
  expect(visible("KiksStudios/Clients/kiks-first-client.md", view)).toBe(false);
});

test("glob metacharacters in a literal path do not widen the match", () => {
  expect(visible("Projects/a+b.md", { include: ["Projects/a+b.md"] })).toBe(true);
  expect(visible("Projects/aab.md", { include: ["Projects/a+b.md"] })).toBe(false);
});

test("an unknown view name throws instead of falling back to everything", () => {
  expect(() => resolveView({ work: { include: ["Work/**"] } }, "wrok")).toThrow(/unknown view/);
  expect(resolveView({}, undefined)).toBeUndefined();
  expect(resolveView({ work: { include: ["Work/**"] } }, "work")).toEqual({ include: ["Work/**"] });
});

test("built-in views cannot be shadowed by a config that redefines them", () => {
  expect(resolveView({ none: { include: ["**"] } }, "none")).toEqual(BUILTIN_VIEWS.none);
});

test("the settings preview reports both halves, so exclusions are reviewable", () => {
  const paths = ["Work/cpa.md", "KiksStudios/Clients/a.md", "Projects/tama/plan.md"];
  expect(partitionByView(paths, { include: ["Projects/**", "Work/**"] })).toEqual({
    visible: ["Work/cpa.md", "Projects/tama/plan.md"],
    hidden: ["KiksStudios/Clients/a.md"],
  });
});
