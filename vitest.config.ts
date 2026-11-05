import { defineConfig } from 'vitest/config'

// Only subrev's own tests. The eval fixtures under evals/ contain deliberately failing
// *.test.js files (they are the agent's task, not ours); without this include list vitest
// would collect them and turn the whole suite red.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Most tests drive the gate with fake scripts and are about orchestration, not confinement:
    // run them unsandboxed so they behave the same on every platform. The sandbox itself is
    // exercised for real (bubblewrap on Linux, Seatbelt on macOS) in tests/integrity/gateSandbox.test.ts
    // and by doctor tests, which set SUBREV_GATE_SANDBOX=auto. Run the whole suite confined with
    // SUBREV_GATE_SANDBOX=auto npx vitest run.
    env: { SUBREV_GATE_SANDBOX: process.env.SUBREV_GATE_SANDBOX ?? 'off' },
  },
})
