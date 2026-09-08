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
    t.startsWith("<bash-input>") ||
    t.startsWith("Caveat: The messages below")
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
 * Turns from both ends until the budget is spent.
 *
 * The same rule the server applies, for the same reason: the first turn states
 * the task and is the single most informative one in the file, and the last
 * turns say how it went. Trimming from the front would drop the goal; trimming
 * from the back would drop the outcome.
 */
export function trimToWire(turns, budget = WIRE_BUDGET) {
  if (turns.length === 0) return turns;
  const cost = (t) => t.text.length + 16;

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
