# subrev

subrev is a CLI that runs a plan, implement, and review pipeline using the `claude` and `codex` CLIs. Your own `check`, `build`, and `test` scripts act as a mechanical gate between steps, and subrev checks that the implementer did not change that gate or weaken the tests before it trusts a green run.

## How it works

1. `subrev new "<description>"` creates a task under `.ai/tasks/<taskId>/` with a `brief.md` for you to complete.
2. `subrev plan <taskId>` reads the brief and codebase, then writes `plan.md` with a file list and acceptance criteria. You can edit it and rerun `plan`.
3. `subrev approve <taskId>` saves `plan-approved.md` and gives every acceptance item a stable id (`AC-1`, `AC-2`, …).
4. `subrev run <taskId>` creates a task branch and uses `codex exec` to implement the plan. Before each gate run it compares the gate definition with the task's base commit (see [Gate integrity](#gate-integrity)); then it runs `scripts/check.sh`, `scripts/build.sh` and `scripts/test.sh`, retrying a failed gate a few times before escalating.
5. Review runs in two phases:
   - **Phase 1 (the gate):** `claude` reviews the diff against the approved plan in a throwaway checkout of the reviewed commit. It can read the rest of the codebase but not the implementer's report: `.ai/` does not exist in that checkout and is also denied to the reviewer.
   - **Phase 2 (report audit):** only after phase 1 has given its verdict, a second call compares the implementer's report with the phase-1 review and the diff, including changes the report does not mention. It is an auxiliary signal for the human and never changes the verdict.
6. On `FAIL`, codex fixes the code. A fix is reviewed again if it changes any non-test file, if the [test-integrity check](#test-integrity) flags it, or if the scope check fires. The re-review sees the previous review and the fix-only diff.
7. On `PASS` the task moves to `awaiting-judgment` with a `judgment-brief.md`: what each fix changed, whether it was re-reviewed, and anything flagged. Business logic is deliberately left to you; the reviewer is told not to judge it.
8. `subrev close <taskId>` merges the task branch, requires `decision-log.md`, and archives the task.

Any failure — an unparseable verdict, a changed gate, a plan the implementer says is wrong, a round limit — escalates to a human instead of retrying indefinitely or continuing silently.

## Safeguards

### Gate integrity

Before every gate run the working tree (committed, uncommitted and untracked files) is compared with the task's base commit for everything under `scripts/`, test-runner configuration (`vitest`, `vite`, `jest`, `playwright`, `cypress`, `karma`, `ava` configs, `.mocharc*`, `pytest.ini`) and the test fields of every `package.json`. Any difference stops the task as `escalated-gate-change` without running the gate or committing; `gate-change-report.md` shows the diff and a fingerprint. Listing a gate file in the plan does not approve the change.

`subrev show-gate <taskId>` re-computes the change from git and shows it. To accept it, pass its fingerprint to the run that should use it: `subrev resume <taskId> --approve-gate <fp>`. The fingerprint is checked against the disk before anything runs and held in memory for that run only; any further edit produces a new fingerprint and blocks again. The gate definition is checked again after the gate runs, and a run that changed it is discarded.

Why not store approvals? The gate runs code the implementer wrote (tests, app code, npm scripts) as your user. An earlier version, before the gate was sandboxed, stored approvals in `~/.subrev` and was shown to be forgeable by such code. The [gate sandbox](#gate-sandbox) now blocks that write, but approvals still never come from disk: `~/.subrev/gate-approvals.log` is an audit log that subrev never reads.

### Gate sandbox

The gate runs code the implementer wrote, so every gate run is confined by the OS: Seatbelt (`sandbox-exec`) on macOS, bubblewrap on Linux. It may write the working tree except `.git`, `.ai` and `scripts/`, plus temp dirs, package caches and anything listed in `SUBREV_GATE_WRITABLE`; everything else is read-only. With no working backend the gate is not run (`SUBREV_GATE_SANDBOX=auto`, the default); `SUBREV_GATE_SANDBOX=off` runs it unconfined and every test log says so. `subrev doctor` probes the sandbox for real.

> **Known limits.** Verified on macOS (Seatbelt) and Linux (bubblewrap); network and package caches stay writable. If subrev itself lives inside the repo it gates, the implementer can change subrev's own source and the build can rebuild it, so run subrev from an install outside the repo. Details: `TEST-INTEGRITY.md`.

### Test integrity

For every test file changed in the reviewed window, subrev compares before and after (TypeScript AST for JS/TS, patterns for pytest): deleted test files, fewer test cases, new `skip`/`todo`/`.only`, fewer assertions, specific matchers replaced by weak ones (`toBeDefined`, `toBeTruthy`, negations, `toThrow()` without an argument), assertions that compare a value with itself or two literals, and removed or rewritten assertion lines. Findings go into the review prompt and force a re-review, including for fixes that only touch tests.

This is a static heuristic. It will miss weakening it has no rule for, such as a tautology through a helper or tests that still run but on trivial inputs.

### Scope check

After a fix, layer 1 (AST-based for JS/TS) flags new files, files outside the plan, and new functions or branches. With `--scope-check layered`, layer 2 groups the changes, runs a revert experiment per group and asks a reviewer to map each group to an acceptance id; only unmapped or unverifiable groups escalate. Details: `SCOPE-CHECK.md`.

## Requirements

- Node.js 20+
- `claude` CLI, authenticated
- `codex` CLI, authenticated
- Three executable scripts in your repo, where exit code 0 means pass: `scripts/check.sh`, `scripts/build.sh`, `scripts/test.sh`

## Install

- `npm install -g @vensery/subrev`
- Or clone the repo, run `npm install && npm run build`, and use `node dist/cli.js`.

## Set up a project

subrev finds your repo through `~/.subrev/projects.json`:

- `repos` maps repo keys to absolute paths. Most projects need only `main`.
- `archiveRepo` (optional) is where `subrev close` and `abandon` push an archived snapshot of the final diff.

To control the models used by `plan` and `review`, add a `## Model tiers` section to `.ai/PROTOCOL.md` with `plan:` and `review:` entries (for example, `opus`). If omitted, `claude`'s default model is used.

Add `.ai/` to your `.gitignore`, since task bookkeeping is not meant to be committed.

## Commands

| Command | Purpose |
|---|---|
| `subrev new <description>` | Create a new task |
| `subrev plan <taskId>` | Generate or regenerate `plan.md` from `brief.md` |
| `subrev approve <taskId>` | Save the current plan as `plan-approved.md` with stable `AC-n` ids |
| `subrev run <taskId> [--scope-check layer1\|layered] [--no-revert] [--strict-unverified]` | Create the task branch and run the implement, gate, review and fix loop |
| `subrev resume <taskId> [--approve-gate <fp>]` | Continue a task stuck in `escalated-*` (same options as `run`); `--approve-gate` approves exactly that gate change for this run |
| `subrev amend-plan <taskId> <planFile>` | Replace the approved plan with an edited file and bump its version |
| `subrev show-gate <taskId>` | Show a blocked gate change, recomputed from git |
| `subrev status` | List all tasks and their statuses, with warnings for unreviewed fixes, weakened tests and audit results |
| `subrev usage [taskId]` | Time and cost per stage (plan, implement, review, fix-review, audit, scope) from `.ai/tasks/<id>/ai-calls.jsonl` |
| `subrev close <taskId>` | Merge the task branch and archive it (requires `decision-log.md`) |
| `subrev abandon <taskId> --reason <reason>` | Abandon a task without merging |
| `subrev retro <taskId> <note>` | Clear a pending retrospective flag |
| `subrev doctor` | Check the environment: binaries, stale `dist/`, that the codex sandbox can write the workspace but not `.git` or `~/.subrev`, and that the gate sandbox works |
| `subrev check-fast-lane` | Flag large or unlabeled diffs that bypass the task-branch flow |
| `subrev eval list\|run\|report\|compare\|scope` | Evaluation harness, see below |

## Evaluation

`subrev eval` runs coding agents on sandboxed tasks (`evals/tasks/`) and compares them: a single agent (`claude[:model]`, `codex[:model]`) against the pipeline (`subrev[:options]`) and its ablations (`noplan`, `noreview`, `nofixreview`, `layered`, `norevert`). Results record pass rate, per-stage time and cost, and escalations; `eval compare` reports a paired bootstrap CI, a Wilcoxon test and a cost-matched pass@k baseline. `eval scope` measures how well the scope detectors catch injected out-of-scope changes.

The question, conditions and decision rule are fixed in advance in `evals/PROTOCOL.md`. **No quality claim is made yet**: the current task set is a harness check, not an experiment. See `evals/README.md`.

## Development

- `npm install`
- `npm test`
- `npm run build`

## License

subrev is released under the MIT license. See `LICENSE` in the repository.
