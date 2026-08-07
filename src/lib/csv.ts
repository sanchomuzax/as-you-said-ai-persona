/**
 * A cell that opens with =, +, - or @ is executed as a formula by Excel and
 * LibreOffice. Research exports carry free-form model output, so a reply that
 * happens to start with "=" would run as code on the researcher's machine. The
 * leading apostrophe is the standard neutraliser and is stripped on import.
 */
function neutralizeFormula(value: string): string {
  if (!/^[=+\-@\t\r]/.test(value)) return value
  // A negative number is not a formula, and prefixing it would turn a numeric
  // column into text for every analysis tool downstream.
  if (value.trim() !== '' && Number.isFinite(Number(value))) return value
  return `'${value}`
}

/** RFC-4180 escaping: quote anything containing a quote, comma or newline. */
export function csvEscape(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value)
  const s = neutralizeFormula(raw)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

/**
 * Explicit column lists everywhere: `SELECT *` returns migrated columns in a
 * different order than a freshly created database, which would make exports from
 * two machines impossible to diff.
 */
export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','))].join('\n')
}
