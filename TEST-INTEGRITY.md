# subrev: gate integrity and test integrity (2026-11-05)

## Problem
The gate is "scripts/check.sh, build.sh, test.sh exit 0", and those scripts, the test-runner
config and the `package.json` test command all live in the repo the implementer can write to.
Before this change production subrev had no equivalent of the eval harness's protected-path
hashes: deleting a failing test, adding `.skip`, weakening an assertion, or editing `test.sh`
produced a green gate, and a test-only fix after a FAIL was not even re-reviewed.

## 1. Gate integrity (deterministic, blocking)
- Before every gate run, the working tree (committed + uncommitted + untracked, gitignored
  excluded) is compared with the task's base commit (`merge-base(baseBranch, HEAD)`) for:
  everything under `scripts/`; test-runner configs (`vitest|vite|jest|playwright|cypress|karma|ava.config.*`,
  `vitest.workspace.*`, `.mocharc*`, `pytest.ini`); and the test fields of every `package.json`
  (`scripts.test*`, `pretest*`, `posttest*`, top-level `jest`/`vitest`/`mocha`/`ava`).
- Any difference → the gate is not run, nothing is committed, status `escalated-gate-change`,
  `gate-change-report.md` with per-file diffs and a fingerprint. No mechanical retry.
- The scripts are still executed in place (they locate the repo with `dirname "$0"`).
- Approval is per exact change and per run: `subrev show-gate <task>` re-computes and shows the
  diff from git (not from `.ai/`); `subrev resume <task> --approve-gate <fp>` approves it for that
  run only (see below). Listing a gate file in the plan approves nothing. Any further change gives a
  new fingerprint and blocks again.
- Fail closed: no `baseBranch` → error, gate not run.

## 2. Test integrity (static, forces review)
- For every test file changed in the reviewed window (`base...HEAD` for the first review,
  `lastReviewedCommit...HEAD` for a fix), JS/TS via the TypeScript AST, pytest via patterns:
  deleted test file; fewer test cases; new skip/todo/x-forms; new `.only`; fewer assertions;
  fewer specific matchers (weak = toBeDefined/toBeTruthy/toBeFalsy/toHaveBeenCalled/toBeInstanceOf,
  any `not.`, `toThrow()` without argument); equality assertions comparing a value with itself
  or two literals; any removed or rewritten assertion line.
- First review: a flagged report is added to the phase-1 prompt.
- Fix: a flagged report forces a re-review under every `fixReview` policy, including test-only
  fixes, and layer 2 cannot waive it. Reports: `test-integrity-implement.md`,
  `test-integrity-round-N.md`; `judgment-brief.md` and `subrev status` surface them.

## Gate approvals: trust boundary (fixed 2026-11-05)
The first version stored approvals in `~/.subrev/gate-approvals.json` and read them back. That only
kept them away from the codex process: the gate runs code the implementer wrote (tests, app code,
npm lifecycle scripts) as the same OS user, outside any sandbox, so that code could write the file.
Reproduced: a test added in one attempt planted an approval for a precomputed fingerprint, the next
attempt neutered `scripts/test.sh`, and the pre-gate check let it through.

Now:
- An approval exists only as `subrev resume <task> --approve-gate <fp>` on the command line of the
  run that uses it. The fingerprint is checked against git and the working tree before anything runs
  and held in memory for that process. Nothing on disk can grant it.
- `~/.subrev/gate-approvals.log` (and `decision-log.md`) are audit records that are never read.
- The gate definition is checked again after the gate runs; if it changed while running (a test that
  rewrites `scripts/test.sh`), the result is discarded and nothing is committed.
- `subrev doctor` probes that `codex sandbox` cannot write `.git` or the state dir.
- Regression tests: `tests/integrity/forgery.test.ts`.

Still open — say so: the gate itself runs unsandboxed with your rights. Code it executes can rewrite
anything on disk between runs: `.ai/` task state (including the recorded base branch), git refs, even
subrev's own `dist/` when subrev lives in the same repo. The in-memory approval closes the forged-approval
path and the post-gate check catches gate edits, but no on-disk check is fully trustworthy after
untrusted code has run as you. The real boundary is to run the gate in a sandbox (macOS `sandbox-exec`:
writes only to the working tree minus `.git`/`.ai`, plus temp and package caches) — next step, needs
testing on macOS.

## Known limits (say this in interviews)
- Static rules miss weakening they have no rule for: a tautology through a helper
  (`expect(f(x)).toBe(g(x))` where g calls f), assertions moved into helpers or snapshots
  regenerated with weaker content, tests that still run but on trivial inputs. The stronger check
  is mutation testing on the acceptance-bound tests (`[tests: ...]`); not built yet (cost).
- "Rewritten assertion line" flags strengthening too: extra reviews are the price of catching
  rewrites the other rules cannot classify.
- Gate scope is a fixed list; a gate that calls code outside `scripts/` (e.g. a test helper
  package) is covered only by test integrity and review, not by the blocking check.
- Implementer prompt rules (do not delete/weaken tests; use deviation-request.md) are still to
  be added and are a nudge, not a protection.
