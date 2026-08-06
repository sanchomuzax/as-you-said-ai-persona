import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'], // process entry point, covered by smoke test at deploy
      thresholds: { statements: 80, functions: 80, lines: 80 }
    }
  }
})
