import type { AgentStats, Summary, TaskStats, UsageTotals } from './stats.js'

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`
const secs = (ms: number | null): string => (ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`)
const num = (value: number | null): string => (value === null ? '–' : value.toFixed(2))

function usageCell(usage: UsageTotals, trials: number): string {
  if (usage.trialsWithUsage === 0) return 'n/a'
  const partial = usage.trialsWithUsage < trials ? ` (${usage.trialsWithUsage}/${trials} trials)` : ''
  const cost = usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(3)}` : ''
  return `${usage.inputTokens + usage.outputTokens} tok${cost}${partial}`
}

function outcomesCell(t: TaskStats): string {
  const parts: string[] = []
  for (const key of ['pass', 'fail', 'tampered', 'error'] as const) {
    if (t.outcomes[key] > 0) parts.push(`${key} ${t.outcomes[key]}`)
  }
  return parts.join(', ')
}

const agentRow = (a: AgentStats): string[] => [
  a.agent,
  String(a.tasks),
  String(a.trials),
  pct(a.macroPassAt1),
  String(a.tampered),
  String(a.errors),
  String(a.flakyTasks),
  secs(a.medianMs),
  usageCell(a.usage, a.trials),
]
const AGENT_HEAD = ['Agent', 'Tasks', 'Trials', 'pass@1 (macro)', 'Tampered', 'Errors', 'Flaky tasks', 'Median time', 'Usage']

const taskRow = (t: TaskStats): string[] => [
  t.agent,
  t.taskId,
  String(t.n),
  `${t.passes}/${t.n}`,
  `${pct(t.passAt1)} [${pct(t.passCi[0])}–${pct(t.passCi[1])}]`,
  `${pct(t.passAtK.value)} (k=${t.passAtK.k})`,
  num(t.meanAttemptsToPass),
  outcomesCell(t),
  secs(t.medianMs),
  t.flaky ? 'yes' : '',
]
const TASK_HEAD = ['Agent', 'Task', 'n', 'Pass', 'pass@1 [95% CI]', 'pass@k', 'Attempts to pass', 'Outcomes', 'Median time', 'Flaky']

const NOTES = [
  'pass@1 is the share of independent trials whose gate passed within the attempt budget; pass@k uses the unbiased estimator of Chen et al. (2021).',
  'The interval is a Wilson 95% interval. With few trials it is wide on purpose: do not read small differences between agents as real.',
  '"Tampered" means the agent changed, added, or deleted a protected file (the tests); those trials count as failures even if the gate went green.',
  'Usage is only reported for agents whose CLI exposes it; "n/a" means unknown, not zero.',
]

function mdTable(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n')
}

export function renderMarkdown(summary: Summary): string {
  return [
    `# Eval report — ${summary.runId}`,
    '',
    `Generated ${summary.generatedAt}`,
    '',
    '## Agents',
    '',
    mdTable(AGENT_HEAD, summary.agents.map(agentRow)),
    '',
    '## Tasks',
    '',
    mdTable(TASK_HEAD, summary.tasks.map(taskRow)),
    '',
    '## Reading this report',
    '',
    ...NOTES.map((n) => `- ${n}`),
    '',
  ].join('\n')
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function htmlTable(head: string[], rows: string[][]): string {
  const th = head.map((h) => `<th>${esc(h)}</th>`).join('')
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('\n')
  return `<table><thead><tr>${th}</tr></thead><tbody>\n${body}\n</tbody></table>`
}

export function renderHtml(summary: Summary): string {
  const bars = summary.agents
    .map(
      (a) =>
        `<div class="bar"><span class="label">${esc(a.agent)}</span>` +
        `<span class="track"><span class="fill" style="width:${(a.macroPassAt1 * 100).toFixed(0)}%"></span></span>` +
        `<span class="val">${pct(a.macroPassAt1)}</span></div>`
    )
    .join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eval report — ${esc(summary.runId)}</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#ddd; --accent:#2a6df4; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181d; --fg:#e8e8e8; --muted:#9aa0a6; --line:#333; --accent:#6ea0ff; } }
  body { background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,sans-serif; margin:0 auto; max-width:1100px; padding:24px 16px; }
  h1 { font-size:22px; margin:0 0 4px } h2 { font-size:17px; margin:28px 0 8px } .meta { color:var(--muted); }
  table { border-collapse:collapse; width:100%; font-size:13px } th,td { border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; white-space:nowrap }
  .wrap { overflow-x:auto }
  .bar { display:flex; align-items:center; gap:10px; margin:6px 0 } .label { width:160px; overflow:hidden; text-overflow:ellipsis }
  .track { flex:1; height:12px; background:var(--line); border-radius:6px; overflow:hidden } .fill { display:block; height:100%; background:var(--accent) }
  .val { width:48px; text-align:right } ul { color:var(--muted) }
</style></head><body>
<h1>Eval report — ${esc(summary.runId)}</h1>
<div class="meta">Generated ${esc(summary.generatedAt)}</div>
<h2>pass@1 by agent (macro average over tasks)</h2>
${bars}
<h2>Agents</h2><div class="wrap">${htmlTable(AGENT_HEAD, summary.agents.map(agentRow))}</div>
<h2>Tasks</h2><div class="wrap">${htmlTable(TASK_HEAD, summary.tasks.map(taskRow))}</div>
<h2>Reading this report</h2>
<ul>${NOTES.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
</body></html>
`
}
