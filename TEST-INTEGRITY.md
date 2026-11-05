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
- Approval is per exact change: `subrev approve-gate <task>` re-computes and shows the diff from
  git (not from `.ai/`), `--fingerprint <fp>` records it only if it still matches the disk.
  Approvals are stored outside the repo (`~/.subrev/gate-approvals.json`, or `SUBREV_STATE_DIR`)
  because the implementer can write `.ai/`. Listing a gate file in the plan approves nothing.
  Any further change gives a new fingerprint and blocks again. `subrev resume` re-runs the task.
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

## Known issue: gate approvals can be forged (fix planned)
Storing approvals outside the repo only keeps them away from the Codex process. The gate itself
runs code the implementer wrote (tests, app code, npm lifecycle scripts) as the same user and
outside any sandbox, so that code can write `~/.subrev/gate-approvals.json`. Reproduced: a test
added in one attempt writes an approval for a precomputed fingerprint, the next attempt neuters
`scripts/test.sh`, and the pre-gate check lets it through. Planned fix: accept an approval only
from the human's own `subrev resume <task> --approve-gate <fp>` (held in memory for that run),
keep `~/.subrev` as an audit log that is never read for decisions, re-check gate integrity after
the gate runs, and probe the Codex sandbox in `subrev doctor`.

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
