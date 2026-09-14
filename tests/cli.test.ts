import { describe, it, expect } from 'vitest'
import { buildProgram } from '../src/cli.js'

describe('cli', () => {
  it('reports the program name and version', () => {
    const program = buildProgram()
    expect(program.name()).toBe('subrev')
    expect(program.version()).toBe('0.1.0')
  })

  it('registers every subcommand', () => {
    const names = buildProgram().commands.map((c) => c.name())
    expect(names.sort()).toEqual(
        [
        'new', 'plan', 'approve', 'run', 'resume', 'amend-plan',
        'status', 'close', 'abandon', 'retro', 'doctor', 'check-fast-lane',
      ].sort()
    )
  })

  it('exposes --force on close and abandon', () => {
    const program = buildProgram()
    const close = program.commands.find((c) => c.name() === 'close')
    const abandon = program.commands.find((c) => c.name() === 'abandon')

    expect(close?.options.some((o) => o.long === '--force')).toBe(true)
    expect(abandon?.options.some((o) => o.long === '--force')).toBe(true)
  })
})
