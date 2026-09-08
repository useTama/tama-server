/**
 * A Claude Code transcript, reduced to the turns a summary is made of.
 *
 * The file is JSONL, one record per line, and most of it is not conversation:
 * in a real session of this size, `tool_use`, `tool_result`, `thinking` and
 * `image` blocks outnumber `text` blocks roughly three to one, and they are the
 * part nobody wants summarised. Every file read, every grep, every diff is in
 * there. What is worth keeping is what the person asked for and what the
 * assistant said back.
 *
 * Dropping the rest is not only a cost decision. A summary written from tool
 * output describes the search rather than the conclusion, which is the opposite
 * of what an engineering log is for.
 */

/** Text out of one record's content, which is a string or a block array. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Noise a user turn carries that the person did not type.
 *
 * Claude Code puts system reminders, command output and file attachments into
 * user turns. Summarising those produces an entry about the harness rather than
 * the work, and they are long, so they crowd out the turns that matter.
 */
function isHarnessNoise(text) {
  const t = text.trimStart();
  return (
    t.startsWith("<system-reminder>") ||
    t.startsWith("<local-command-") ||
    t.startsWith("<command-name>") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<bash-input>") ||
    t.startsWith("Caveat: The messages below") ||
    // A skill's whole body arrives as a user turn. They are the largest fake
    // user messages in a real transcript - one measured at 103,268 characters -
    // so missing them costs the budget as well as the summary's accuracy.
    t.startsWith("Base directory for this skill:")
  );
}

/**
 * Turns from transcript lines, oldest first.
 *
 * `isSidechain` marks a subagent's turns. A session that fanned out over
 * twenty agents would otherwise have twenty agents' conversations in its
 * summary, and none of them is the session.
 */
export function turnsFrom(lines) {
  const turns = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A truncated last line is normal: the transcript is written as the
      // session runs and the hook reads it the moment the session ends.
      continue;
    }
    if (record.isSidechain) continue;
    // `isMeta` marks a user turn the harness wrote rather than the person: an
    // image placeholder, an injected note. 76 of 1546 user records in a real
    // corpus, none of them typed by anybody.
    if (record.isMeta) continue;
    if (record.type !== "user" && record.type !== "assistant") continue;

    const text = textOf(record.message?.content).trim();
    if (!text) continue;
    if (record.type === "user" && isHarnessNoise(text)) continue;

    turns.push({ role: record.type, text });
  }
  return turns;
}

/**
 * Characters of transcript worth putting on the wire.
 *
 * Measured rather than guessed: a 25MB session reduces to about 500
 * conversational turns and 690KB of text, and the server will summarise about
 * 40KB of that. Shipping the other 650KB accomplishes nothing except making a
 * session teardown slow on a phone tether.
 *
 * Deliberately well above the server's own cap. The server re-trims - a cap
 * that lives only in a client is not a cap - and leaving headroom means raising
 * the server's limit does not need every installed client to update first.
 */
const WIRE_BUDGET = 120_000;

/**
 * One turn's ceiling on the wire, twice the server's own.
 *
 * Without it, the backward fill below stopped at the first turn bigger than
 * the remaining budget and shipped only the opening turn - so a session whose
 * last message was a large paste sent the task and threw away the outcome,
 * which is the exact failure the fill exists to avoid. Real transcripts carry
 * turns of 103KB and 185KB (pasted terminal output, an injected skill body),
 * so this is not a hypothetical shape.
 *
 * Clipped rather than skipped, because a huge turn can be the outcome. Twice
 * `MAX_TURN_CHARS` in src/session-summary.ts, which keeps the same headroom
 * over the server that WIRE_BUDGET keeps over its character budget: the server
 * will clip to 4,000 anyway, and a later raise there finds the text still here.
 */
const MAX_TURN_WIRE_CHARS = 8_000;

/**
 * Turns from both ends until the budget is spent.
 *
 * The same rule the server applies, for the same reason: the first turn states
 * the task and is the single most informative one in the file, and the last
 * turns say how it went. Trimming from the front would drop the goal; trimming
 * from the back would drop the outcome.
 */
export function trimToWire(turns, budget = WIRE_BUDGET) {
  if (turns.length === 0) return turns;
  const clip = (t) =>
    t.text.length > MAX_TURN_WIRE_CHARS
      ? { role: t.role, text: `${t.text.slice(0, MAX_TURN_WIRE_CHARS)}\n[...turn truncated]` }
      : t;
  const cost = (t) => t.text.length + 16;

  turns = turns.map(clip);
  const first = turns[0];
  if (turns.length === 1 || cost(first) >= budget) return [first];

  let left = budget - cost(first);
  const tail = [];
  for (let i = turns.length - 1; i >= 1; i--) {
    if (cost(turns[i]) > left) break;
    left -= cost(turns[i]);
    tail.unshift(turns[i]);
  }
  return [first, ...tail];
}

/**
 * The project name, from the directory the session ran in.
 *
 * The same convention `tama session` and `record_session` already use, so a
 * hook-filed entry lands in the same file as one the model filed by hand
 * rather than beside it under a second name.
 */
export function projectFrom(cwd) {
  const parts = String(cwd ?? "").split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Whether a session ending this way is worth summarising.
 *
 * `resume` is not an ending. It fires when the session is picked up again, so
 * filing on it would write an entry for work that is still going on, and then
 * write another when it actually finishes.
 */
export function shouldFile(reason) {
  return reason !== "resume";
}
