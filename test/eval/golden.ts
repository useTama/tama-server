/**
 * The golden set for /ask, written against the frozen fixture vault.
 *
 * Never against a real vault. A golden set that reads someone's notes cannot
 * be committed, cannot be run in CI, and stops being golden the moment they
 * capture something new. `test/fixtures/vault/` exists so this file can assert
 * exact paths and stay true.
 *
 * `find` is the scored claim: those notes must reach the retrieved set, or the
 * answer was never possible. `top` is stricter, and is only set where the
 * fixture contains a deliberate near-miss that shares vocabulary, so that a
 * retriever which merely matches keywords fails while one that discriminates
 * passes. `gist` is only read by the gated live run.
 */

export type Golden = {
  id: string;
  q: string;
  /** Must appear in the retrieved set. */
  find: string[];
  /** Must rank first. Set only where a distractor makes that a real test. */
  top?: string;
  /**
   * A `top` this retriever is known to get wrong, and why. The case still
   * runs, as an expected failure, so that fixing retrieval turns it green
   * instead of leaving a commented-out line nobody ever uncomments.
   */
  knownGap?: string;
  /** Fragments the answer should contain, lowercased. Live run only. */
  gist?: string[];
};

export const ANSWERABLE: Golden[] = [
  { id: "mic", q: "why was the mic clipping",
    find: ["Inbox/2025-01-08-1412-mic-gain.md"], gist: ["45", "60"] },
  { id: "standup", q: "what time is standup now",
    find: ["Inbox/2025-01-09-0803-standup.md"], gist: ["9:15"] },
  { id: "passport", q: "when does my passport expire",
    find: ["Inbox/2025-01-14-0655-passport.md"], gist: ["november", "2026"] },
  { id: "molar", q: "what did the dentist say about the molar",
    find: ["Inbox/2025-01-15-1830-dentist.md"], gist: ["crown"] },
  { id: "rent", q: "how much is the rent going up",
    find: ["Inbox/2025-01-18-1105-rent.md"], gist: ["8"] },
  { id: "brakes", q: "when is the car service due",
    find: ["Inbox/2025-01-21-0740-car-service.md"], gist: ["40000"] },
  { id: "schengen", q: "when do schengen appointment slots open",
    find: ["Inbox/2025-02-02-0915-schengen.md"], gist: ["9", "first"] },
  { id: "shoulder", q: "why am i not doing overhead press",
    find: ["Inbox/2025-02-05-1745-shoulder.md"], gist: ["six weeks"] },
  { id: "digest", q: "should the digest be daily or weekly",
    find: ["Inbox/2025-02-08-0830-digest.md"], gist: ["weekly"] },

  // The pipeline and the cost note both say kubeflow. A retriever that only
  // matches the project name cannot tell these apart, and both questions have
  // exactly one right answer.
  { id: "kubeflow-fail", q: "what breaks the kubeflow training pipeline",
    find: ["Work/kubeflow-pipeline.md"], top: "Work/kubeflow-pipeline.md",
    gist: ["s3", "rotate"] },
  { id: "kubeflow-cost", q: "how much is the idle gpu node pool costing",
    find: ["Work/kubeflow-costs.md"], top: "Work/kubeflow-costs.md",
    gist: ["1400"] },

  { id: "migration", q: "what is blocking the events table migration",
    find: ["Work/postgres-migration.md"], top: "Work/postgres-migration.md",
    gist: ["primary key"] },

  // q1-goals also names p95 latency, as a target rather than a cause.
  // The first real finding from this eval, and now fixed. q1-goals won by a
  // hair because it contains the phrase "p95 latency ... list endpoint"
  // verbatim, while the note that actually explains the latency never says
  // the word in its body, only in its filename. Notes that explain a thing
  // tend not to repeat its name, which is the shape of question keyword
  // scoring is worst at.
  //
  // The diagnosis above is what fixed it. Proximity was paying a compact
  // restatement of a question more than a spread-out answer to it, so
  // W_PROXIMITY was halved to 1. Keep this case: it is the only thing in the
  // set holding that weight down, and nothing yet holds it up.
  { id: "latency", q: "why is p95 latency high on the list endpoint",
    find: ["Work/latency-investigation.md"], top: "Work/latency-investigation.md",
    gist: ["n+1", "tags"] },

  { id: "hiring", q: "what did we change about the hiring loop",
    find: ["Work/hiring-loop.md"], top: "Work/hiring-loop.md",
    gist: ["take home", "pairing"] },
  { id: "anand", q: "what was the feedback on anand",
    find: ["Work/interview-feedback-anand.md"], top: "Work/interview-feedback-anand.md",
    gist: ["testing", "platform"] },
  { id: "oncall", q: "is oncall weekly or fortnightly",
    find: ["Work/oncall-rotation.md"], gist: ["weekly"] },
  { id: "security", q: "what did the security review flag",
    find: ["Work/security-review.md"], gist: ["expire", "admin token"] },
  { id: "datadog", q: "what is the datadog renewal situation",
    find: ["Work/vendor-contracts.md"], gist: ["june", "logs"] },
  { id: "deploys", q: "how long does a deploy take to drain",
    find: ["Work/runbook-deploys.md"], gist: ["90"] },
  { id: "offsite", q: "when and where is the offsite",
    find: ["Work/team-offsite.md"], gist: ["coorg", "march"] },

  { id: "402", q: "why did openrouter return a 402",
    find: ["Projects/tama/max-tokens.md"], top: "Projects/tama/max-tokens.md",
    gist: ["max_tokens", "before"] },
  { id: "lid", q: "what is the problem with whatsapp lid addressing",
    find: ["Projects/tama/whatsapp-lid.md"], gist: ["allowlist", "c.us"] },
  { id: "embeddings", q: "what did i decide about embeddings",
    find: ["Projects/tama/decisions.md"], top: "Projects/tama/decisions.md",
    // Ranks THIRD today, behind the attention paper and the max-tokens note,
    // by 0.27 and 0.19. Recorded as a gap rather than left unasserted: the
    // case previously claimed recall only, so the note that holds the answer
    // sitting below two notes that merely share its vocabulary was invisible.
    //
    // It is the shape a ranking change is most likely to make worse - a
    // question of the form "what did I decide about X" against a decisions
    // file whose entry for X is one line among many - so an inversion here
    // should be a red test, not a silent regression. test.failing means
    // fixing retrieval turns this green instead of needing somebody to
    // remember to uncomment it.
    knownGap: "the decisions note mentions embeddings once, in a line about choosing grep instead, while a paper titled for attention and a note about token caps both use the word more often",
    gist: ["grep"] },
  { id: "mcp", q: "how many mcp tools are there and does it use oauth",
    find: ["Projects/tama/mcp.md"], gist: ["five", "no oauth"] },
  { id: "hermes-drop", q: "why did hermes drop four thousand messages",
    find: ["Projects/hermes/incident-2025-01-30.md"],
    top: "Projects/hermes/incident-2025-01-30.md", gist: ["503", "429"] },
  { id: "hermes-queues", q: "why does hermes have one queue per operator",
    find: ["Projects/hermes/architecture.md"], top: "Projects/hermes/architecture.md",
    gist: ["independent"] },

  // priya is named in the standup note too, which is about a meeting time.
  { id: "priya", q: "what does priya want and what is blocking it",
    find: ["Meetings/2025-01-16-priya-1on1.md"], top: "Meetings/2025-01-16-priya-1on1.md",
    gist: ["platform", "ingestion"] },
  { id: "board", q: "what does the board want that we cannot give them",
    find: ["Meetings/2025-01-22-board-prep.md"], gist: ["retention", "cohort"] },
  { id: "capture-button", q: "what did design review say about the capture button",
    find: ["Meetings/2025-02-04-design-review.md"], gist: ["one tap", "lock screen"] },

  { id: "positional", q: "what did i note about positional encoding",
    find: ["Reading/papers/attention-is-all-you-need.md"], gist: ["added"] },
  { id: "planning-fallacy", q: "what is the fix for the planning fallacy",
    find: ["Reading/thinking-fast-and-slow.md"], gist: ["reference class"] },
  { id: "leaderless", q: "what does leaderless replication trade away",
    find: ["Reading/designing-data-intensive-applications.md"], gist: ["read repair"] },

  { id: "amma", q: "when is amma's birthday and what did she want",
    find: ["Personal/gift-ideas.md"], gist: ["12", "pressure cooker"] },
  { id: "dal", q: "when does the tamarind go into the dal",
    find: ["Personal/recipes.md"], top: "Personal/recipes.md", gist: ["end"] },
  { id: "elss", q: "when is the elss deadline and how much is left",
    find: ["Personal/finances.md"], gist: ["march", "60"] },
  { id: "jrpass", q: "is the jr pass worth buying",
    find: ["Personal/travel-japan.md"], gist: ["two long legs"] },

  { id: "vitamind", q: "what is my vitamin d dose",
    find: ["Health/bloodwork-2025-01.md"], top: "Health/bloodwork-2025-01.md",
    gist: ["60000", "weekly"] },
  { id: "coffee", q: "how does coffee affect my sleep",
    find: ["Health/sleep.md"], top: "Health/sleep.md", gist: ["2pm", "deep sleep"] },
  { id: "knee", q: "what keeps my knee happy when running",
    find: ["Health/running.md"], gist: ["concrete"] },

  // The two cases that hold a weight up from below. Every other case here
  // constrains the weights from above - it fails when a signal is too strong -
  // and W_PROXIMITY and W_RECENCY could both be set to zero with all of them
  // still green. A weight with pressure from only one side is a weight nobody
  // can tune, which is what these two are for. Verified by zeroing each: the
  // matching case fails and the other does not.
  //
  // Both distractors are honest. Every term is present for a real reason, so
  // the case tests arrangement and age rather than whether an artificial note
  // loses.
  { id: "warmer", q: "why did the cache warmer start timing out",
    // Work/platform-misc.md carries every term of this question, more often
    // than the answer does, and never two within one excerpt window. Only
    // proximity separates them.
    find: ["Work/shard-rebalance.md"], top: "Work/shard-rebalance.md",
    gist: ["shard", "thirty"] },
  { id: "snapshots", q: "how long are staging database snapshots kept",
    // Work/retention-policy.md says thirty days and is a month older;
    // Work/storage-review.md says seven and is three days old. Matched on
    // coverage, repetition and path so that only age decides, which is the
    // "confidently stale" failure this whole thing exists to avoid.
    find: ["Work/storage-review.md"], top: "Work/storage-review.md",
    gist: ["seven"] },
];

/**
 * Questions the fixture vault cannot answer.
 *
 * These are the anti-hallucination test. Each one shares vocabulary with real
 * notes on purpose, because a question with no overlap at all retrieves
 * nothing and any prompt refuses it correctly by accident.
 */
export const UNANSWERABLE: Array<{ id: string; q: string; fabricationTell?: RegExp }> = [
  // `fabricationTell` is the shape the invented answer would take. Checking
  // for it is judge-free and precise, where matching refusal phrasings would
  // not be: the friend voice refuses in Hinglish, in one clause, differently
  // every time, and a keyword list for that grades tone instead of honesty.
  { id: "bp", q: "what was my blood pressure at the january bloodwork",
    fabricationTell: /\d{2,3}\s*\/\s*\d{2,3}/ },
  { id: "lisbon", q: "what time is my flight to lisbon in april",
    fabricationTell: /\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b/i },
  { id: "geyser", q: "what did the plumber quote for the geyser",
    fabricationTell: /(?:rs\.?|₹)\s*\d|\b\d{3,}\s*(rupees|bucks)\b/i },
  { id: "priya-salary", q: "what did we agree priya's new salary would be",
    fabricationTell: /\b\d[\d,.]*\s*(lakh|lpa|crore)\b/i },
  // No tell for these two. Any specific at all would be invented, so the
  // zero-citations check carries them.
  { id: "aws-password", q: "what is the aws root account password" },
  { id: "cricket", q: "who won the cricket match on saturday" },
];
