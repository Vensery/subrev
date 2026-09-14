# subrev

A CLI that orchestrates a **plan → implement → review** pipeline on top of the `claude` and `codex` CLIs,
with a mechanical gate (your own `check`/`build`/`test` scripts) enforced between every step. It exists so
an AI-authored change never lands without: a plan you can read and edit before any code is written, a
real green build/test run, and an independent AI code review that can only pass by reading the actual
diff.

## How it works

1. `subrev new "<description>"` scaffolds a task under `.ai/tasks/<taskId>/` with a `brief.md` for you to
   fill in — the spec of what should be built.
2. `subrev plan <taskId>` reads the brief and your codebase, and writes `plan.md`: a concrete file list and
   numbered acceptance criteria. Read it, edit it, re-run `plan` as needed.
3. `subrev approve <taskId>` locks in `plan-approved.md`.
4. `subrev run <taskId>` creates a task branch, hands the approved plan to `codex exec` to implement, runs
   your `scripts/check.sh` / `scripts/build.sh` / `scripts/test.sh` after every attempt, and only proceeds
   to review once they're green (auto-retrying a red gate a few times before escalating back to you).
5. On a green gate, `claude` independently reviews the diff against the approved plan — with no access to
   the implementer's own report — and the task lands in `awaiting-judgment` on `PASS`, or escalates back to
   you on `FAIL` or an unparseable verdict.
6. `subrev close <taskId>` merges the task branch, requires a `decision-log.md` first, and archives the
   task.

Every step that can go wrong (a red gate that won't turn green, a review that can't be parsed, an
implementer that thinks the plan itself is wrong) escalates back to a human rather than silently retrying
forever or silently proceeding.

## Requirements

- Node.js 20+
- The [`claude`](https://docs.claude.com/en/docs/claude-code) CLI, authenticated
- The [`codex`](https://github.com/openai/codex) CLI, authenticated
- Your repo provides three executable scripts subrev calls as its mechanical gate:
  `scripts/check.sh`, `scripts/build.sh`, `scripts/test.sh` (exit 0 = pass)

## Install

```bash
npm install -g subrev
```

(Or clone this repo, `npm install && npm run build`, and use `node dist/cli.js`.)

## Set up a project

subrev resolves which repo you're working in from `~/.subrev/projects.json`:

```json
{
  "my-project": {
    "repos": { "main": "/absolute/path/to/your/repo" },
    "archiveRepo": "/absolute/path/to/an/archive/repo"
  }
}
```

- `repos` maps arbitrary repo keys to absolute paths — most projects just need one, `main`.
- `archiveRepo` (optional) is where `subrev close`/`abandon` push an archived snapshot of each task's
  final diff; omit it if you don't want that.

Optionally, add a `## Model tiers` section to `.ai/PROTOCOL.md` at your repo root to control which model
alias `plan` and `review` invoke `claude --model` with:

```markdown
## Model tiers

- plan: opus
- review: opus
```

Both default to `claude`'s own default model if this file or section is absent.

Also add `.ai/` to your repo's `.gitignore` — subrev's own per-task bookkeeping lives under
`.ai/tasks/<taskId>/` and isn't meant to be committed.

## Commands

| Command | Does |
|---|---|
| `subrev new <description>` | Scaffold a new task |
| `subrev plan <taskId>` | Generate/regenerate `plan.md` from `brief.md` |
| `subrev approve <taskId>` | Lock in the current plan as `plan-approved.md` |
| `subrev run <taskId>` | Create the task branch and run the full implement → gate → review loop |
| `subrev resume <taskId>` | Continue a task stuck in `escalated-*` |
| `subrev amend-plan <taskId> <planFile>` | Replace the approved plan with an edited file, bumping its version |
| `subrev status` | List all tasks and their status |
| `subrev close <taskId>` | Merge the task branch and archive (requires `decision-log.md`) |
| `subrev abandon <taskId> [--reason]` | Abandon without merging |
| `subrev retro <taskId> <note>` | Clear a pending retrospective flag |
| `subrev doctor` | Diagnose environment/setup issues (missing binaries, stale `dist/`, etc.) |
| `subrev check-fast-lane` | Flag large/unlabeled diffs bypassing the task-branch flow |

## Development

```bash
npm install
npm test
npm run build
```

## License

MIT — see [LICENSE](./LICENSE).
