# Scope check

After a review asks for a fix, subrev checks whether the fix stayed within the approved plan. The
check has two layers. Neither claims to understand what the code means; the goal is to **detect
and escalate suspicious out-of-scope changes**, and the eval in `evals/` measures how well that
works.

```bash
subrev run <task>                          # layer 1 only (default)
subrev run <task> --scope-check layered    # layer 1, then layer 2 when layer 1 fires
subrev run <task> --scope-check layered --no-revert          # skip the revert experiment
subrev run <task> --scope-check layered --strict-unverified  # also escalate mappings no test needs
```
`SUBREV_SCOPE_CHECK=layered` sets the default for `run` and `resume`.

## Acceptance-criterion IDs

Layer 2 maps every change to an acceptance item, so items need stable IDs. `subrev approve`
rewrites the plan's acceptance section into `- AC-1: ...` form (a plain `1. ...` list is numbered
by position) and refuses a section with duplicate IDs or no items. An item can name the tests that
check it: `- AC-2: rejects spaces [tests: spaces throw]`. `amend-plan` keeps existing IDs and warns
when an amendment removes or rewords one. See `src/acceptance.ts`.

## Layer 1 — cheap trigger (`src/mechanicalCheck.ts`)

Fires on: a new file not in the plan's `## Files`, a changed file not in the plan, a new callable
(function, class, method, function-valued const), or a new branch (`if`, `switch`, `?:`, `catch`)
in a declaration. JS/TS files are compared at the AST level, so a comment containing the word
"function" or an `if` that only moved does not fire; other languages keep the keyword regexes.
It is deliberately over-sensitive: on the reference solutions it fires on 3 of 5 clean cases.

## Layer 2 — map every change to an acceptance item (`src/scope/`)

1. **Group** (`groups.ts`). The diff is split into change groups by the declaration each hunk
   touches (TypeScript parser for JS/TS; git's hunk heading otherwise). Hunks that span several
   declarations are split. Grouping is deterministic; the model never decides where a change ends.
2. **Revert experiment** (`ablation.ts`). Each group is reverted on its own (at symbol level for
   JS/TS: the old declaration is put back, or a new one removed), the gate is run, and the tree is
   restored. Red means tests depend on the change. Green means no test needs it — evidence, not a
   verdict, because tests are incomplete. Skipped when the gate is not green at HEAD. Costs one
   gate run per group (capped at 12).
3. **Map** (`layer2.ts`). A reviewer that sees only the plan and the diff (never the implementer's
   notes) classifies each group as `direct` (implements an AC), `supporting` (prerequisite for a
   named AC) or `unmapped`, citing AC ids, the group's locations, and a counterfactual: what would
   break for the cited AC without this change. Output is JSON against a fixed schema.
4. **Decide** (deterministic code, not the model). Escalate a group when it is unmapped, unclassified,
   cites an AC id not in the plan, gives no usable counterfactual, or is unmapped while tests depend
   on it (plan and tests disagree). A `direct`/`supporting` claim on a group no test needs is marked
   `unverified` (escalated with `--strict-unverified`).

If any group escalates, the next review round is forced and receives the scope report. If layer 2
fails for any reason, the fix is treated as flagged (layer-1 behaviour). Reports are written to
`.ai/tasks/<id>/scope-report-round-<n>.md`, with the reviewer's raw output next to them.

## Known limits

- The revert experiment can only prove that tests need a change. Requested-but-untested work
  (docs, logging, error messages) shows up as `unverified`, and only the reviewer can vouch for it.
- Reverting a group can break the build for reasons unrelated to scope (a removed declaration still
  referenced elsewhere); that reads as "load-bearing", which errs towards not escalating.
- The reviewer's diff view uses git's line alignment, which can show a closing brace in the
  neighbouring group.
