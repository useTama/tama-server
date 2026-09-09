/**
 * Scripted conversations, for measuring what `summarise()` actually keeps.
 *
 * `SUMMARY_PROMPT` names four things worth keeping - what was decided, names
 * and who said what, anything someone is waiting on, and any running joke or
 * nickname - and nothing anywhere asserted that a returned paragraph contained
 * any of them (#62). `test/memory.test.ts` covers the fold, the count and the
 * atomic delete, but its model is a fake that returns a canned string, so no
 * test could see what a real one writes.
 *
 * ## Why this is data and not a note in the fixture vault
 *
 * A scripted thread in `test/fixtures/vault/` would break the 48-file
 * assertion and become an accidental distractor for the retrieval cases, which
 * `test/fixtures/README.md` warns about specifically. This is conversation, not
 * notes; it belongs beside the eval that reads it.
 *
 * ## The two constraints that decide the shape
 *
 * `SUMMARISE_AFTER` is 30 and is a module constant rather than a parameter of
 * `summarise()`, so a thread must genuinely exceed thirty turns or the fold
 * never happens and the eval grades an empty summary. And `summarise` folds
 * `total - keep` turns from the OLDEST end, so with `KEEP_TURNS` at 12 a
 * 34-turn thread folds turns 1 to 22 - every fact being measured has to sit
 * inside that range, or it is still in the verbatim tail and the summary was
 * never asked to carry it.
 */

export type ThreadTurn = {
  role: "user" | "assistant";
  /** Who said it, for the turns where attribution is the thing being tested. */
  speaker?: string;
  text: string;
};

export type ThreadProbe = {
  id: string;
  /** Which of SUMMARY_PROMPT's four promises this probe is checking. */
  kind: "decision" | "attribution" | "waiting" | "nickname";
  /**
   * Groups of alternatives, all lowercase. Every group must be satisfied by at
   * least one of its members, so a probe can accept "waiting on legal" or
   * "legal has not come back" without accepting a summary that mentions
   * neither.
   */
  anyOf: string[][];
  /** What a failure means, read by a person looking at a red eval. */
  why: string;
};

export type ThreadCase = {
  id: string;
  /** Oldest first, in exactly the shape `remember()` takes. */
  turns: ThreadTurn[];
  probes: ThreadProbe[];
};

/**
 * One thread, 34 turns, with the four facts in the folded range.
 *
 * The filler is deliberately the kind of thing nobody refers back to -
 * greetings, acknowledgements, a tangent about lunch - because
 * `SUMMARY_PROMPT` also promises to DROP that, and a thread of nothing but
 * load-bearing sentences would not test the compression at all.
 */
const ROLLOUT: ThreadCase = {
  id: "rollout",
  turns: [
    { role: "user", speaker: "Priya", text: "morning. are we still doing the flag rollout this week" },
    { role: "assistant", text: "That was the plan. Anything changed?" },
    { role: "user", speaker: "Priya", text: "Anand thinks we should hold it until the legal sign-off lands" },
    { role: "assistant", text: "Is legal actually blocking, or is it a formality?" },
    { role: "user", speaker: "Anand", text: "it is blocking. we cannot ship a data-residency flag before they confirm the wording" },
    { role: "assistant", text: "Understood. So the rollout waits on legal." },
    { role: "user", speaker: "Priya", text: "ok then we decided: rollout moves to the 24th, after legal confirms" },
    { role: "assistant", text: "Noted, the 24th." },
    { role: "user", speaker: "Anand", text: "and I am still waiting on legal to come back on the wording, they have had it eight days" },
    { role: "assistant", text: "Eight days is a while. Do you want to chase it?" },
    { role: "user", speaker: "Anand", text: "I will chase tomorrow" },
    { role: "assistant", text: "Fine." },
    { role: "user", speaker: "Priya", text: "haha the Hydra is going to hate this" },
    { role: "assistant", text: "The Hydra being the staging cluster?" },
    { role: "user", speaker: "Priya", text: "yes, the Hydra, because every time we cut one head off it grows two more deploys" },
    { role: "assistant", text: "Right. The Hydra it is." },
    { role: "user", speaker: "Priya", text: "anyway lunch. is the place near the office still open" },
    { role: "assistant", text: "No idea, I only know what is in your notes." },
    { role: "user", speaker: "Priya", text: "fair" },
    { role: "assistant", text: "Anything else on the rollout?" },
    { role: "user", speaker: "Anand", text: "no that is it" },
    { role: "assistant", text: "Okay." },
    // ---- from here on the turns stay verbatim in the tail (KEEP_TURNS = 12).
    { role: "user", speaker: "Priya", text: "thanks" },
    { role: "assistant", text: "Sure." },
    { role: "user", speaker: "Priya", text: "one more thing, unrelated" },
    { role: "assistant", text: "Go on." },
    { role: "user", speaker: "Priya", text: "do we have a runbook for the queue backlog" },
    { role: "assistant", text: "There is a deploys runbook. Nothing specific to the queue." },
    { role: "user", speaker: "Priya", text: "ok I will write one" },
    { role: "assistant", text: "Good idea." },
    { role: "user", speaker: "Anand", text: "I can review it" },
    { role: "assistant", text: "Noted." },
    { role: "user", speaker: "Priya", text: "right, done for now" },
    { role: "assistant", text: "Talk later." },
  ],
  probes: [
    {
      id: "decision",
      kind: "decision",
      anyOf: [["24th", "24"], ["rollout", "flag"]],
      why: "SUMMARY_PROMPT promises to keep what was decided. The decision here is a date, and a summary that loses it makes the next reply contradict a plan the user remembers making.",
    },
    {
      id: "attribution",
      kind: "attribution",
      anyOf: [["priya"], ["anand"]],
      why: "It promises names and who said what. In a group both names matter: a summary that says 'they decided' cannot tell the next reply who to answer.",
    },
    {
      id: "waiting",
      kind: "waiting",
      anyOf: [["legal"], ["waiting", "wait", "blocked", "chase", "sign-off", "confirm"]],
      why: "It promises anything someone is waiting on. This is the one that decays quietly: an unblocked-looking summary makes a later reply cheerfully suggest shipping.",
    },
    {
      id: "nickname",
      kind: "nickname",
      anyOf: [["hydra"]],
      why: "It promises any running joke or nickname that would make a later reply make sense. Lose it and 'is the Hydra ok' becomes unanswerable two turns after it stopped being explained.",
    },
  ],
};

export const THREADS: ThreadCase[] = [ROLLOUT];
