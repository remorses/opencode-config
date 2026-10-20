# pstack procedures

Concrete procedures that go with the principles in `SKILL.md`. Read the section the task
needs.

## Todo list

- For a multi-step task, put the steps in the todo list before task-specific items. A step
  you decide not to do stays in the list as `skip: <reason>`. Skipped work stays visible.
- Before any fan-out, add four items. A dimension that does not apply stays as
  `n/a: <reason>`:
  - **Blocking first steps.** Gates that run before fan-out.
  - **Independent workstreams.** Disjoint files or layers parallelize. Shared writes
    serialize.
  - **Shared mutable state.** Split the target first. Serialize only for real invariants.
  - **Smallest safe decomposition.** If one worker is best, say why.

## Subagents

- **Fresh subagent per round.** Give the new agent the original brief, every later
  directive, the previous agent's report and its branch. Resume an old agent only when it
  holds state that is costly to move (uncommitted changes, a running dev server). Resumed
  chains silently drop directives.
- **You own its work.** Review the diff and write your own summary. Never pass on what it
  said. A second opinion is the same prompt on a different model.
- **Brief template.** Every field filled, or the unit is not scoped yet:

```
GOAL        one sentence, the outcome, executable by a stranger with no chat access
SCOPE       paths it may write, paths it may not, its own worktree or branch
CONTEXT     file and PR pointers; upstream reports pasted in full, workers cannot see siblings
ACCEPTANCE  checkable criteria, one per line
VERIFY      exact commands or the surface to drive, plus known gotchas
TIMEBOX     rough cap; on expiry return partial findings and stop
FORBIDDEN   no rebase, no force-push, no fixes outside scope, plus unit-specific bans
REPORT      status, branch, head SHA, verdict, what you actually ran, deviations
```

  Collapse it to one paragraph for a one-command unit, but keep goal, scope, verify and
  report shape.
- **One writer per worktree or branch.** Parallel agents in one worktree overwrite each
  other.
- **Standing orders.** On large fan-outs, when you catch yourself restating an
  instruction, append it to a numbered orders file and paste that file into every spawn.

## Verdict words

- Task verdict: `VERIFIED`, `NOT VERIFIED`, `INCONCLUSIVE`. Inconclusive is not a pass.
  A check on the wrong surface is not a pass. Never hide a negative.
- Parallel worker report: `PASS`, `ISSUES`, `BLOCKED`, each with evidence. A worker lists
  every defect it can prove, not only the first.
- Review buckets: **Act on** (blocks a real PR), **Consider** (legit, unclear cost),
  **Noted** (valid, not actionable now), **Dismissed** (wrong or missing context, with a
  reason). More than 5 Act on items means you are not filtering. Never auto-apply review
  findings.
- The agent that judges a change should not be the one that wrote it.

## Benchmarks

Write the claim you expect to ship first ("export is 30% faster at p50 on the 60k-row
fixture"), then test that sentence:

1. Run `uptime` and check the core count. On a busy machine, interleave sides and say so.
2. **Why not double?** Profile in a run you do not report and name the limiter.
3. **Tuned?** Both sides run as production does: release build, same flags, data, cache
   state. A limiter that is a setting (debug build, commit per row, missing index) means
   that side is untuned.
4. **Limits?** Compare against disk, network and core arithmetic.
5. **Errors?** Count failures and check outputs are correct, not just present.
6. **Reproduces?** At least 5 runs per side, alternating A, B, A, B. Report median and
   range. A gap smaller than run-to-run variation is no difference.
7. **Matters?** Measure the end-to-end path the user waits on. Report a micro result as a
   share of the whole.
8. **Happened?** Confirm the work ran inside the timed region: no unawaited promises,
   unconsumed generators or timeouts.

Verdict: faster, slower, no measurable difference, or inconclusive. Example line: "p50
41 ms → 33 ms, median of 7 runs per side, range 32 to 35 ms after, bound by JSON parsing on
one core."

For profiles and heap snapshots, load the artifact into sqlite (one row per sample, frame
or node) and query it instead of reading raw JSON.

## Hillclimb loop

For sustained improvement of one metric:

1. Pick a workload that reproduces the complaint. If none does, fix the repro first.
2. Fix the metric, the direction, and a stop predicate that pairs a target with a minimum
   number of attempts ("50% better and at least 10 iterations"), so a lucky early win
   cannot end the run.
3. Build the harness, prove it separates a slow case from a fast one, then freeze it. It
   prints an error count and a count of work done. Record baseline and a green regression
   run.
4. Each hypothesis names a mechanism ("defer X off the boot path because it blocks first
   paint"), not "try memoizing something".
5. One change, measure before and after, run the regression gate. Keep only if the metric
   moves past noise and the gate stays green. Otherwise revert in full. Log the row
   either way.
6. On a plateau, pivot category, combine near-misses, re-read the source. Correctness and
   simplicity outrank the number.

## Autonomous and overnight runs

- **Earn trust first.** Do the task once by hand or watch one run. The agent must have the
  same tools you would use. Every stage must be able to stop the line.
- **Contract:** stepping-away notice + a pass/fail done check ("zero old callers, all
  fixtures pass, old API deleted") + a fresh worktree + permissions given up front + a
  decision log + an escape hatch ("if truly stuck after a few hours, stop and write up
  why"). A duration is not a done check.
- **Loop:** check the predicate, make the smallest justified change, verify on the real
  artifact, commit if it advanced, discard if not, log one row. A plateau is not a stop:
  pivot. Never relax the predicate to declare victory.
- **Mid-run discoveries are yours.** Fix related bugs, flaky verifiers and broken tooling
  in separate commits, then return to the predicate. Escalate only irreversible actions,
  product calls, or a real dead end. Never ask "should I keep going".
- **Decision log** (`decisions.tsv`, not committed unless a reviewer needs it):

```
ts	phase	decision	why	evidence	result
2026-05-24T09:40:00Z	harness	screenshotted old version before changes	compare old vs new	scripts/snapshot.sh	saved 120 baselines
2026-05-24T12:30:00Z	widget	threw out a helper's work, screenshots were blank	checked files, not its summary	worktree reset	reverted
```

  Log decision points, not every action. Append-only: a wrong row gets a new row that
  supersedes it. Evidence is a pointer (SHA, `file:line`, artifact path), never prose.
  At the end, check each row against what actually happened, and ask a model from another
  family to flag weak evidence and skipped verification.

## Pause and pickup

- **Pause:** finish or back out of the current step, start nothing new, commit edits as one
  `wip:` commit, write a resume note to `/tmp/<slug>-resume.md` (intent, progress, what is
  verified, next steps, key files, gotchas). No irreversible action to pause.
- **Pickup:** the prior trail is authoritative. Reconstruct branch, landed commits, open
  todos and decisions. Name the resume point. Do not redo finished work. Verify inherited
  claims on the real artifact, not from the prior self-report.

## Project verification harness

Every serious project needs a scripted way to drive the real app. If missing, build one
(for example a skill or script using playwriter, tuistory or HTTP) with:

- **Launch:** exact command and how to tell it is ready (usable, not just answering).
  Works from an empty data dir, including migrations and seed data.
- **Doctor:** one read-only check that the instance is worth driving: process up, right
  build, port owned by us, auth valid.
- **Drive:** real selectors and commands from this repo. Stable handles over coordinates.
- **Evidence:** capture the action and the resulting state, plus side effects (files,
  rows, messages). Verify what a dry-run actually skips instead of trusting its name.
- **Cleanup:** kill only what you started, never by process name. Evidence survives
  cleanup.
- Run it end to end once before trusting it. A harness never executed is a draft.

When agents keep writing throwaway scripts to drive the app, build a small control CLI
instead: few composable commands, `--dry-run` on destructive ones, JSON output, errors
that say what to do instead.

## Fixing a repeated mistake class

1. Read recent commits, reverts, review comments and workaround comments. Group mistakes
   into classes. A class counts once it has happened twice.
2. Fix the most frequent classes one commit each, at the highest level from `SKILL.md`
   section 6. Prove each new check fails on a real past mistake. Run the same command
   locally and in CI.
3. Exceptions go on the offending line with a reason and an expiry date.
4. Keep a table in AGENTS.md pairing each rule with what enforces it. A rule that nothing
   enforces and that was broken again is a repeat: move it up a level.
