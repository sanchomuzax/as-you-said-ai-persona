import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // `public/**` is deliberately NOT listed. The frontend is classic scripts
      // with a shared global scope, so the tests evaluate them (concatenated, as
      // the browser does) instead of importing them as modules — and V8 cannot
      // attribute lines executed inside an eval back to a file. Adding them here
      // reports a flat 0% for files that ARE tested, which is a worse signal
      // than leaving them out. The frontend's regression net is the DOM harness
      // in tests/helpers/load-app-dom.ts: it loads the real index.html and the
      // real view controllers against a stubbed API, and a broken renderer fails
      // a test there. Frontend coverage is therefore tracked by that suite, not
      // by this number.
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'], // process entry point, covered by smoke test at deploy
      thresholds: { statements: 80, functions: 80, lines: 80 }
    }
  }
})
