/**
 * Prints the active token budget limits (no secrets) — useful after editing .env
 * to confirm the running configuration.
 *
 * Usage: npx tsx scripts/show-budget.ts
 */
import { loadConfig } from '../src/config.js'

const config = loadConfig()
process.stdout.write(
  `TOKEN_BUDGET_PER_RUN = ${config.TOKEN_BUDGET_PER_RUN.toLocaleString('hu-HU')}\n` +
    `TOKEN_BUDGET_GLOBAL  = ${config.TOKEN_BUDGET_GLOBAL.toLocaleString('hu-HU')}\n` +
    `PORT                 = ${config.PORT}\n`
)
