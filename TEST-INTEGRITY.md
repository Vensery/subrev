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

## Gate sandbox (2026-11-05)
Every gate run (and every revert-experiment gate run) executes inside an OS sandbox:
- writable: the working tree **except** `.git`, `.ai` and `scripts/`; temp dirs; package caches
  (`~/.npm`, `~/.cache`, `~/Library/Caches`, pnpm/yarn stores); paths a human lists in
  `SUBREV_GATE_WRITABLE`. Everything else, including the rest of your home directory and
  `~/.subrev`, is read-only. Reads, process execution and network are unrestricted.
- backends: macOS Seatbelt (`/usr/bin/sandbox-exec`, a profile with a single deny rule so rule
  order cannot matter) and Linux bubblewrap. Scripts still run in place, so `dirname "$0"` works.
- `SUBREV_GATE_SANDBOX=auto` (default) refuses to run the gate — before codex is even called — if no
  backend works. `off` runs unconfined and every `test-log.md` says so. A subrev started inside a
  gate sandbox (its own test suite run by an outer gate) does not nest; the outer sandbox confines it.
- `subrev doctor` runs a real probe: a write inside the tree must succeed, writes to `.git`, `.ai`,
  `scripts/` and `~/.subrev` must fail.
- Verified on Linux (bubblewrap): the whole suite passes with every gate run confined, and a gate
  "test" that tries to rewrite `scripts/test.sh`, create a git ref and edit `.ai/` meta is denied all
  three.
- macOS: `subrev doctor`'s real probe passed on the first try, but the sandbox tests failed for repos
  under the temp dir: the first profile only carved `.git`/`.ai`/`scripts/` out of the repo rule, so
  the temp-dir allowance re-allowed them when the repo lived in `/private/var/folders` (as in tests
  and eval sandboxes). Fixed: protected dirs are now denied on their own inside the single deny rule.
- Verified on macOS (codex-cli 0.144.0, Node 25): `subrev doctor` passes all checks including the gate
  sandbox probe, and the whole suite passes with `SUBREV_GATE_SANDBOX=auto` (every gate run under Seatbelt).

Still open — say so:
- subrev living inside the repo it gates. SelfMatch's `build.sh` rebuilds `tools/subrev/dist`, and a
  task may legitimately edit `tools/subrev/src`, so the implementer can change the next subrev run.
  No sandbox fixes that; run subrev from an install outside the repo (e.g. a pinned global install).
- Writes the sandbox allows: anything else in the working tree (app code, configs — caught by the
  post-gate check if gate-relevant), temp dirs and package caches (a poisoned npm cache could affect a
  later install). Network is open.
- Hard links: a link created in the tree to a file in a protected location may let writes through on
  some filesystems; not tested.

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
