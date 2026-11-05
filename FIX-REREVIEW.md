# subrev: fix re-review, judgment brief, undisclosed-change audit (2026-11-04)

## Problem
After a review FAIL, Codex's fix was re-reviewed only if the scope check fired. A fix that quietly changed logic inside a planned file (changed constant/condition, no new function/branch) went straight to awaiting-judgment, and the human got no signal that logic had moved.

## Decisions (in this order)
1. Every fix that changes a non-test file is re-reviewed (default `fixReview: 'non-test'`). Layer 2 can waive a review the scope check asked for, never one forced by non-test code. Test-only fixes keep the old scope-check rule.
2. The human always gets the fix diff: `fix-round-N.patch` + `fix-round-N.md` (files classified test/code, changed declarations, decision and reasons) and `judgment-brief.md` at awaiting-judgment; `subrev status` flags unreviewed fixes.
3. The audit also flags changes the report doesn't disclose (deterministic file-mention list + model check). Auxiliary only: never changes the verdict, never replaces code review.
4. Measure the extra review: production logs every AI call to `.ai/tasks/<id>/ai-calls.jsonl` (claude now runs with `--output-format json`), `subrev usage` summarizes; eval has stage `fix-review` and ablation A5 = `nofixreview`.

## Other changes
- Review files are `review-N.md` per round (round 3 used to overwrite review-2.md).
- Re-review prompt starts with `[subrev: fix re-review]`, includes the previous review and the fix-only diff, asks to verify each finding and list "Changes beyond the review".
- Round cap reached while a code fix still needs review → abandoned; decision-log says the fix was never reviewed.

## Historical estimate (30 past tasks, before real measurement)
- 7 tasks had review-driven fixes; the new rule would have added a re-review in 2 (fix-pass-path, f1d). In fix-pass-path the human gate later found two defects in that unreviewed fix.
- Round-1 review wall time from file timestamps: median ~143 s (26–617 s, 21 tasks); rough proxy. No historical cost data.

## Not yet verified
- Real claude CLI with `--output-format json` + `--disallowedTools`.
- Real cost: run T vs A5 per `evals/PROTOCOL.md`, and check `subrev usage` after real tasks.
