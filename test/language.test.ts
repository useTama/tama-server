import { test, expect } from "bun:test";
import { detectLanguage, languageLine } from "../src/language.ts";

test("plain English is English", () => {
  for (const message of [
    "Can you see images?",
    "Tama install path?",
    "what are my todos",
    "whats my todos",
    "Are not just kubeflow but all todos",
  ]) {
    expect(detectLanguage(message)).toBe("english");
  }
});

// These are the messages from the session where it drifted. Each one has to
// come back Hinglish or the hint would be pushing the reply the wrong way.
test("romanised Hindi is Hinglish", () => {
  for (const message of [
    "Kis kis chhez pr kaal krna hai ab?",
    "Ye bataya to tha? Not in memory?",
    "To pahle kyu nahi list kiye?",
    "Uske alawaa iict?",
    "kya hua bhai",
    "note add kar diya hai",
  ]) {
    expect(detectLanguage(message)).toBe("hinglish");
  }
});

// A single Hindi word in an English sentence is code-mixing, and answering it
// in flat English is the flattening MIRROR forbids.
test("one Hindi word in an English sentence is still code-mixing", () => {
  expect(detectLanguage("thanks bhai")).toBe("hinglish");
  expect(detectLanguage("that PR is done, abhi review baaki hai")).toBe("hinglish");
});

// Each of these is a real Hindi transliteration that is also an English word.
// Including any of them would make every English sentence read as Hinglish.
test("English words that are also Hindi words do not tip it", () => {
  for (const message of [
    "I need to ship it",
    "the deploy is done",
    "he said so",
    "is it me",
    "to the point",
    // A real message from the session, and the known cost of the rule above.
    // Its only Hindi marker is "to", which is excluded because it is also an
    // English word. Reading a sentence this English as English is the right
    // trade: the alternative tips every English sentence containing "to".
    "Hmm to how can we get it to be proper next time",
  ]) {
    expect(detectLanguage(message)).toBe("english");
  }
});

test("a language this cannot read is not asserted to be English", () => {
  // A wrong hint is worse than none, because the hint overrides MIRROR and
  // MIRROR gets this right on its own.
  expect(detectLanguage("இது என்ன")).toBeUndefined();
  expect(detectLanguage("यह क्या है")).toBeUndefined();
  expect(detectLanguage("これは何ですか")).toBeUndefined();
});

test("a message with one Latin brand name in it is still not English", () => {
  expect(detectLanguage("Kubeflow का काम कैसा चल रहा है")).toBeUndefined();
});

test("a message with no letters gets no hint", () => {
  for (const message of ["?", "!!", "2026", "👍", "   "]) {
    expect(detectLanguage(message)).toBeUndefined();
  }
});

test("the hint names the language and disowns the earlier turns", () => {
  const line = languageLine("english")!;
  expect(line).toContain("in English, so reply in English");
  // The clause that does the work. Without it the model is choosing between a
  // rule and twelve of its own worked examples.
  expect(line).toContain("off this message alone");
  expect(line).toContain("not an instruction");

  expect(languageLine("hinglish")).toContain("code-mixed Hinglish");
  expect(languageLine(undefined)).toBeUndefined();
});

// These three were in HINDI_MARKERS and are ordinary English nouns, so one hit
// being the threshold meant a plain English question came back in Hinglish.
test("English nouns that look like Hindi words are not markers", () => {
  for (const message of [
    "did i write anything about the yoga mat",
    "what hue did i pick for the logo",
    "notes on the koi pond",
  ]) {
    expect(detectLanguage(message)).toBe("english");
  }
});

test("dropping those three does not cost the real Hinglish cases", () => {
  // In practice neither "koi" nor "mat" turns up without another marker beside
  // it, which is what made them safe to lose.
  expect(detectLanguage("koi baat nahi")).toBe("hinglish");
  expect(detectLanguage("mat karo yaar")).toBe("hinglish");
});
