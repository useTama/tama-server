# The fixture vault

Forty-eight synthetic notes in `vault/`, frozen. `test/eval/golden.ts` asserts these exact
paths, so a rename here breaks thirty tests over there.

It exists so the eval set can be committed, run in CI, and stay true. A golden
set written against a real vault cannot be any of those: it discloses someone's
notes, and it stops being golden the moment they capture something new.

Two properties are load-bearing and easy to destroy by accident:

- **Near-misses are deliberate.** `Work/kubeflow-costs.md` exists so that a
  question about the kubeflow *pipeline* has something plausible to lose to.
  Same for `Work/q1-goals.md` against `Work/latency-investigation.md`, and the
  standup note against Priya's 1:1. Delete a distractor and the discrimination
  tests start passing for free.
- **The unanswerable questions share vocabulary with real notes.** A question
  with no overlap retrieves nothing, and any prompt refuses it correctly by
  accident.
- **Two pairs exist to hold a weight up from below** (#65), and they are
  matched on purpose. `Work/shard-rebalance.md` against
  `Work/platform-misc.md` differ only in arrangement: the distractor carries
  every term of the `warmer` question, more often than the answer does, and
  never two inside one excerpt window, so only proximity separates them.
  `Work/storage-review.md` against `Work/retention-policy.md` differ only in
  age, matched on coverage, repetition and path so that only recency decides.
  Editing either pair - a term added, a paragraph shortened, a file renamed
  into the question's vocabulary - stops it measuring anything. Check by
  setting `W_PROXIMITY` or `W_RECENCY` to 0: exactly one case must fail.

Nothing here is real. The names, numbers and incidents are invented; the
writing is imitated from the kind of note this tool receives, which is why some
of it is ungrammatical.

This file lives beside the vault rather than inside it. A README in `vault/`
is a note as far as the retriever is concerned, and it would turn up as a
search result talking about the tests.

Adding a note means updating the count assertion in
`test/eval/retrieval.eval.test.ts` and thinking about whether it becomes an
accidental distractor for an existing case.
