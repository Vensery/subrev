import { defineConfig } from 'vitest/config'

// Only subrev's own tests. The eval fixtures under evals/ contain deliberately failing
// *.test.js files (they are the agent's task, not ours); without this include list vitest
// would collect them and turn the whole suite red.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
