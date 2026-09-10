/**
 * Which language this message is in, so twelve turns of history cannot decide
 * it.
 *
 * `MIRROR` asks for the language of the current message and always has. It is
 * one line, in the system prompt. Against it, `buildMessages` spreads up to
 * `KEEP_TURNS` prior turns in as real messages, which is right and is the
 * reason follow-ups work at all. It has a side effect: twelve assistant turns
 * in one language are twelve demonstrations of how this assistant talks, and a
 * demonstration beats a description.
 *
 * So it drifted, and could not come back. Partway through a real session the
 * replies switched to Hinglish and stayed there, including for plainly English
 * questions: "Can you see images?" was answered "nahi dekh sakta, text padh
 * sakta hu sirf", and an English question about a build path several turns later
 * was answered in Hinglish too. Every turn after the drift added another
 * example, and the summariser then folded the drifted turns into a paragraph
 * written the same way, so it outlived the turns that caused it.
 *
 * The fix is not to weaken history. History is what makes a follow-up work, and
 * `memory.ts` is explicit that folding beats truncating. The fix is a stronger
 * per-turn signal, stated where the other per-turn facts live.
 *
 * ## Two languages, and the honesty about the rest
 *
 * This distinguishes romanised Hindi from English and nothing else, because
 * that is the pair the owner actually code-mixes. A Tamil or French message
 * returns undefined rather than being asserted to be English: a wrong language
 * hint is worse than none, since `MIRROR` alone gets it right most of the time
 * and a hint overrides `MIRROR`.
 *
 * No dependency, and no statistical model. The cost of being wrong is one reply
 * in the wrong register, not a failure, and a word list is auditable in a way a
 * trigram model is not.
 */

/**
 * Romanised Hindi function words that are not also English words.
 *
 * Curated against collisions rather than for coverage, which is what lets one
 * hit be enough. "to", "the", "he", "me", "so" and "is" are all real Hindi
 * transliterations and all excluded, because each of them appears in ordinary
 * English and would make every English sentence read as Hinglish.
 *
 * One hit is the threshold on purpose. A single "bhai" in an otherwise English
 * sentence IS code-mixing, and answering it in English would be exactly the
 * flattening `MIRROR` forbids.
 */
const HINDI_MARKERS = new Set([
  // to be, to do, to happen
  "hai", "hain", "hoga", "hogi", "honge", "hona", "tha", "thi", "thé",
  "kar", "karna", "karke", "karo", "karta", "karti", "karte", "kiya",
  "diya", "liya", "dena", "lena", "hua", "hui", "hue", "gaya", "gayi", "gaye",
  "raha", "rahi", "rahe", "chahiye", "chaiye",
  // question words
  "kya", "kyun", "kyu", "kyunki", "kaise", "kaisa", "kaisi", "kahan", "kaha",
  "kab", "kitna", "kitne", "kaun", "konsa",
  // pronouns and possessives
  "mujhe", "tujhe", "tumhe", "tune", "tumne", "maine", "mera", "meri", "tera",
  "teri", "tumhara", "uska", "iska", "unka", "apna", "apni", "khud",
  // the oblique demonstratives, which carry a sentence like "uske alawaa" that
  // has no verb in it and would otherwise read as English
  "uske", "iske", "unke", "inke", "usko", "isko", "unko", "inko",
  "kis", "kisi", "kisko", "kiska", "alawa", "alawaa",
  // negation and affirmation
  "nahi", "nahin", "mat", "haan", "bilkul",
  // postpositions and connectives that do not collide
  "mein", "aur", "bhi", "toh", "phir", "lekin", "magar", "kaash", "warna",
  // common adverbs, quantifiers, discourse
  "abhi", "bas", "sab", "kuch", "koi", "thoda", "bahut", "zyada", "jyada",
  "matlab", "yaar", "bhai", "achha", "acha", "accha", "theek", "thik", "sahi",
  "badhiya", "wala", "wale", "wali", "jaise", "waise", "itna", "pade", "bache",
  "dekh", "bol", "chal", "samajh", "bata", "batao", "hoga",
]);

/** Latin letters, so a script check does not depend on a locale. */
const LATIN = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

export type Language = "english" | "hinglish";

/**
 * The language of one message, or undefined when it cannot be said.
 *
 * Undefined for a message with no letters at all ("?", "👍", "2026"), and for
 * one written mostly outside the Latin script. Both are cases where the honest
 * answer is to say nothing and let `MIRROR` mirror.
 */
export function detectLanguage(message: string): Language | undefined {
  const letters = [...message].filter((c) => LETTER.test(c));
  if (letters.length === 0) return undefined;

  // Mostly non-Latin means this is a language this function does not know. Two
  // thirds rather than all, so one Latin brand name in a Devanagari or Tamil
  // sentence does not tip it.
  const latin = letters.filter((c) => LATIN.test(c)).length;
  if (latin / letters.length < 0.67) return undefined;

  const words = message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  return words.some((w) => HINDI_MARKERS.has(w)) ? "hinglish" : "english";
}

const NAMES: Record<Language, string> = {
  english: "English",
  hinglish: "code-mixed Hinglish",
};

/**
 * The per-turn instruction, phrased to beat the examples rather than repeat
 * them.
 *
 * `MIRROR` already says "same language". Saying it again in the same words
 * would add a thirteenth voice to a vote history is winning, so this names the
 * language outright and says explicitly that the earlier turns are not the
 * instruction. That second clause is the whole point: without it the model is
 * being asked to choose between a rule and its own worked examples.
 */
export function languageLine(language: Language | undefined): string | undefined {
  if (!language) return undefined;
  return `This message is in ${NAMES[language]}, so reply in ${NAMES[language]}. `
    + `Read that off this message alone. Earlier turns in this conversation may be in another `
    + `language, including your own, and they are not an instruction about which to use now.`;
}
