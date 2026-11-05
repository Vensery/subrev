# subrev eval — a small harness for coding agents

Runs a coding agent against sandboxed tasks, gates every attempt with a real command, and
reports pass@1 / pass@k with confidence intervals, attempts-to-pass, time, and (when the
agent CLI exposes it) tokens and cost.

```bash
subrev eval list
subrev eval run --agent mock:solve mock:retry mock:flaky mock:tamper mock:fail --trials 3
subrev eval run --agent claude codex --trials 5 --task parse-duration fix-map-limit
subrev eval report .ai/evals/<run>      # re-render from results.jsonl

# the subrev pipeline as an agent, and a paired, cost-aware comparison against a baseline
subrev eval run --agent claude:sonnet subrev:impl=claude,model=sonnet,plan=sonnet,review=sonnet --trials 5
subrev eval compare .ai/evals/<run> --baseline claude:sonnet --treatment subrev:impl=claude,model=sonnet,plan=sonnet,review=sonnet

# the scope detectors themselves, on reference solutions with injected unrequested changes
subrev eval scope --reviewer mock:lenient          # decision rules only, no model
subrev eval scope --reviewer claude:sonnet --trials 3
```

Before running anything with a real model, read [PROTOCOL.md](PROTOCOL.md): it fixes the
conditions, metrics and decision rule in advance, and `eval compare` reports whether that rule
was met.

Output goes to `.ai/evals/<timestamp>/`: `results.jsonl` (one line per trial, appended as it
runs), `summary.json`, `report.md`, `report.html`.

## How a trial works

1. Copy `tasks/<id>/fixture/` into a fresh temp dir and `git init` it.
2. Run the agent with the task prompt (+ gate command + protected paths).
3. **Integrity check:** hash every file under `protectedPaths` (the tests). If any was changed,
   added, or deleted, the trial is `tampered` and counts as a failure even if the gate is green.
4. Run the gate (`task.json` → `gate`). Exit 0 = pass. On failure the next attempt receives the
   failing gate output (this mirrors subrev's mechanical retries). Up to `maxAttempts`.

## Agents

- `mock:<solve|fail|retry|flaky|tamper>`: deterministic stand-ins for testing the harness.
- `claude[:model]`, `codex[:model]`: one agent, with the gate output fed back for up to
  `maxAttempts` attempts.
- `subrev[:options]`: the full subrev pipeline in the sandbox (plan → approve → implement + gate →
  review → fix → scope check). The runner calls it once per trial and it spends the same retry
  budget internally. Options, comma-separated: `impl=codex|claude`, `model=`, `plan=`, `review=`,
  `noplan`, `noreview`, `layered`, `norevert`, `nofixreview`, `rounds=<n>`, `mock`. Per-stage time,
  tokens and cost (when the CLI reports them) are recorded in `results.jsonl` under `stages`, and the
  pipeline's end state and escalation counts under `pipeline`. Fix re-reviews are their own stage
  (`fix-review`), so `T` vs `nofixreview` (A5) isolates what that review costs and catches.
  Production runs log the same stages per task to `.ai/tasks/<id>/ai-calls.jsonl`; `subrev usage`
  summarizes them.

## Comparing agents

`subrev eval compare <runDir...> --baseline A --treatment B` pairs the two agents by task and
reports: macro final and first-attempt pass rates; the mean per-task difference with a
hierarchical bootstrap 95% CI (tasks, then trials within tasks; seeded); an exact Wilcoxon
signed-rank test over tasks; win/loss/tie counts; cost per trial and per stage; and a
**cost-matched baseline**: pass@k of the baseline at k = floor(treatment cost / baseline cost),
i.e. "run the baseline k times and keep a passing attempt", which is what the extra spend would
buy without the pipeline.

## Scope-detector eval

`subrev eval scope` builds, for every task with a `reference/` solution, a clean case (the
reference) and one case per injected unrequested change (`extra-export`, `new-file`,
`config-edit`, `feature-flag`), and reports recall and false-positive rate with Wilson intervals
for four detectors: `layer1` (AST/regex trigger), `revert-only` (flag any change no test needs),
`layer2-only` (reviewer AC mapping + revert evidence) and `layered` (what `--scope-check layered`
does). Injected cases are easier than natural scope creep; PROTOCOL.md describes the hand-labelled
set needed for real-world numbers.

## Adding a task

```
tasks/<id>/task.json     id (= directory name), title, prompt, gate, protectedPaths, maxAttempts,
                         optional acceptance: ["item [tests: test name, ...]", ...]
tasks/<id>/fixture/      starting repo (the gate must be RED here)
tasks/<id>/reference/    known-good files overlaid on the fixture (the gate must be GREEN)
```

`tests/eval/tasks.test.ts` checks the red/green property for every task, so a task whose gate
cannot fail (or cannot pass) breaks the suite instead of silently producing meaningless numbers.

## What this does and does not tell you

- The `mock:*` agents are deterministic stand-ins for testing the harness. Their numbers say
  nothing about any model.
- The `claude` / `codex` adapters shell out to the installed CLIs. Their default flags can be
  overridden with `SUBREV_EVAL_CLAUDE_ARGS` / `SUBREV_EVAL_CODEX_ARGS`, and they have not been
  validated against every CLI version. Check one real run before trusting a batch.
- Five small tasks and a handful of trials give wide intervals. Treat differences between agents
  as real only when the intervals clearly separate.
- Five tasks are a harness check. PROTOCOL.md requires at least 10 paired tasks before any
  claim, and `eval compare` will not report the decision rule as met with fewer.
- Not covered yet: drift detection across runs, parallel trials, tasks beyond small Node.js
  functions, and tooling for the hand-labelled scope set (the procedure is in PROTOCOL.md).
