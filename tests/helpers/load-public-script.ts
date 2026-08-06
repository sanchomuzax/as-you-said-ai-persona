import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Loads DOM-free browser scripts from `public/` and returns the selected
 * bindings. The UI is plain classic scripts (no bundler), so pure helpers are
 * evaluated here instead of imported — this keeps them unit-testable without
 * pulling a full DOM environment into the test run. Multiple files are
 * concatenated in order, mirroring how the browser shares their global scope.
 */
export function loadPublicScript<T>(files: string | string[], exportExpression: string): T {
  const list = Array.isArray(files) ? files : [files]
  const source = list
    .map((file) => readFileSync(fileURLToPath(new URL(`../../public/${file}`, import.meta.url)), 'utf8'))
    .join('\n')
  const factory = new Function(`${source}\nreturn ${exportExpression};`)
  return factory() as T
}
