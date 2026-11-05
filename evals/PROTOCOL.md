# Evaluation protocol: does the subrev pipeline beat a single agent?

This file is written **before** any real-model run. Its job is to fix the question, the
conditions, the metrics and the decision rule in advance, so the result cannot be reshaped after
the numbers are in. The decision rule is also implemented in code (`protocolVerdict` in
`src/eval/compare.ts`) and printed at the top of every `subrev eval compare` report.

Change this file only before a round starts. If something has to change mid-round, record it under
"Deviations" with the date and the reason, and treat that round as exploratory.

## 1. Questions

- **Q1 (quality).** On the same tasks, with the same implementer model, does the subrev pipeline
  (plan → implement + gate → review → fix → scope check) reach a higher final pass rate than a
  single agent with the same gate feedback, **at matched cost**?
- **Q2 (cost attribution).** What does each stage (plan, implement, review, scope) cost, and what
  does removing it change?
- **Q3 (scope).** How often do the scope detectors flag unrequested changes (recall), and how often
  do they flag requested ones (false positives)?

Until Q1 is answered under this protocol, no claim of the form "subrev improves quality" is made.

## 2. Conditions

All conditions use one implementer model `M` (fill in below) so that a difference is attributable
to the pipeline structure, not to a different coder.

| ID | Agent spec | What it is |
| --- | --- | --- |
| B | `claude:M` | Single agent. Gate feedback loop up to the task's `maxAttempts`. |
| B@k | (computed from B) | Best of k independent B trials with the gate as verifier = pass@k. k is set by the cost ratio; see §5. |
| T | `subrev:impl=claude,model=M,plan=M,review=M` | Full pipeline, layer-1 scope check (production default). |
| A1 | `subrev:impl=claude,model=M,plan=M,review=M,noreview` | Ablation: no review loop. |
| A2 | `subrev:impl=claude,model=M,plan=M,review=M,noplan` | Ablation: no planning stage. |
| A3 | `subrev:impl=claude,model=M,plan=M,review=M,layered` | Layered scope check (layer 1 + revert experiment + AC mapping). |
| A4 | `subrev:impl=claude,model=M,plan=M,review=M,layered,norevert` | Layered without the revert experiment. |
| A5 | `subrev:impl=claude,model=M,plan=M,review=M,nofixreview` | Ablation: a fix is re-reviewed only when the scope check fires (the policy before 2026-11-04). T re-reviews every fix that changes a non-test file; T − A5 is the cost, time and pass-rate effect of that rule. |

The production configuration (`impl=codex`) may be run as an extra row, but it is not part of the
Q1 comparison because it changes the implementer.

The pipeline gets the same mechanical retry budget as B (`maxMechanicalRetries = maxAttempts - 1`)
and is invoked once per trial; the eval runner does not add its own retry loop on top.

## 3. Tasks

- The task set is frozen at the start of a round: record the task ids and the git commit of
  `evals/tasks/` below. Tasks added after seeing results go into the next round.
- **No claim is made with fewer than 10 paired tasks** (`protocolVerdict` enforces this). The current
  5 tasks are a harness check, not an experiment. Target for round 1: at least 20 tasks.
- Every task must pass the red/green check in `tests/eval/tasks.test.ts` and should list
  `acceptance` items (used by the scope eval and by plan-less ablations).
- New tasks should include cases where scope creep is tempting (a brief that mentions a related
  feature without asking for it, an obvious refactor next to the bug) and at least a few beyond
  single-function Node.js changes.

## 4. Trials

- B: 10 trials per task (enough to estimate pass@k up to k = 10 without extrapolation).
- T and A1–A5: 5 trials per task.
- Trials run sequentially with fresh sandboxes. Record CLI versions (`claude --version`,
  `codex --version`) and the subrev commit below.

## 5. Metrics

**Primary:** macro final pass rate — per task, the share of trials whose gate passed within the
budget without touching protected paths; then averaged over tasks with equal weight.

**Secondary (reported, not used in the decision):**
- first-attempt pass rate (B: attempt 1 of the feedback loop; pipeline: its single end-to-end run),
- mean cost and tokens per trial, and per stage for pipeline conditions,
- median wall time per trial,
- tampering count,
- escalation rate: share of pipeline trials that ended in `escalated-*`/`abandoned` or had a layer-2
  scope escalation. This is the automatic proxy for "human interventions". Whether an escalation
  was *justified* is answered by the scope eval (§7), not by this rate.

**Cost matching.** Let r = mean cost per trial of T ÷ mean cost per trial of B. The cost-matched
baseline is B@k with k = ⌊r⌋, capped at B's trials per task (the report says when the cap binds,
which favours T). If either side lacks cost data, the cost-matched comparison is "not available"
and the decision rule cannot be met.

## 6. Analysis and decision rule

- Pair by task. Tasks not run under both conditions are excluded and listed.
- Point estimate: mean over tasks of (pass rate T − pass rate B).
- Interval: hierarchical bootstrap (resample tasks with replacement, then trials within each task),
  10,000 iterations, seed 1. Trials within a task are not independent, so pooled-trial tests such as
  McNemar on all runs are not used.
- Test: exact two-sided Wilcoxon signed-rank on the per-task differences.

**T is declared better than B only if all of the following hold:**
1. at least 10 paired tasks;
2. the 95% bootstrap CI lower bound of the difference is above 0;
3. Wilcoxon p < 0.05;
4. T's macro pass rate is above the cost-matched baseline B@k.

Otherwise the result is reported as "no demonstrated improvement", with the numbers. Ablations
(A1–A5) are reported descriptively against T with the same statistics; they inform Q2 and are not
held to the decision rule.

Always reported, whatever the outcome: the per-task table, all conditions run, errored trials and
their causes, and any deviation from this protocol.

## 7. Scope detectors (Q3)

Two ground-truth sets, reported separately and never pooled.

**Injected set** (`subrev eval scope`). Each task's reference solution, clean and with one injected
unrequested change (`extra-export`, `new-file`, `config-edit`, `feature-flag`). Reports recall and
false-positive rate with Wilson intervals for: layer 1 alone, the revert experiment alone, layer 2
alone, and the layered combination used by `--scope-check layered`. Run with `--reviewer claude:M`
and `--trials 3` for the model-dependent rows. Known bias: injected changes are unrelated and
untested, so this recall is an upper bound, and clean references are fully tested, so the revert
experiment looks better here than it will on real work.

**Natural labelled set** (manual; not yet automated). Take the `scope-report-round-*.md` files from
A3 runs (`subrev eval run ... --keep-sandboxes`). For each change group, a person who has not seen
the detector's decision labels it `in-scope`, `out-of-scope` or `unsure`, using only the approved
plan and the diff. At least 50 labelled groups before reporting. Report group-level precision and
recall of `escalate` against `out-of-scope`, with `unsure` excluded and counted. Detector outputs
are never used as labels: scoring a detector with its own pipeline is circular.

Wording allowed once these exist: "detects and escalates suspicious out-of-scope changes, with
recall X and false-positive rate Y on N labelled groups". Not allowed: any claim that it
understands code semantics or catches all scope creep.

## 8. Threats to validity

- Small Node.js tasks may not represent real repositories; results do not transfer automatically.
- Public tasks or reference solutions may be in a model's training data.
- CLI flags and output formats drift; check one real trial by hand before trusting a batch.
- Both conditions see the same gate command, so neither has privileged test information; but a
  pipeline that runs the gate more often is spending more, which the cost matching accounts for.
- Cost is only as accurate as the CLI reports it; codex does not report cost, which is why Q1 uses
  `impl=claude`.

## 9. Pre-registration record

Fill in before round 1 starts:

- Date:
- subrev commit:
- `evals/tasks/` commit and task ids:
- Model M:
- CLI versions:
- Conditions to run (from §2):

## 10. Deviations

(none yet)
