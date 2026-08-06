import { loadConfig, loadModels } from './config.js'
import { createDb } from './db.js'
import { OpenRouterClient } from './openrouter.js'
import { buildServer } from './server.js'

const config = loadConfig()
const models = loadModels()
const db = createDb(config.DATABASE_PATH)
const client = new OpenRouterClient(config.OPENROUTER_API_KEY, config.OPENROUTER_BASE_URL)

const app = buildServer({ db, config, models, client })

app.listen({ port: config.PORT, host: '0.0.0.0' }).then((address) => {
  process.stdout.write(`as-you-said listening on ${address}\n`)
}).catch((error) => {
  process.stderr.write(`Failed to start: ${String(error)}\n`)
  process.exit(1)
})
