# as-you-said — AI Persona Survey Research Platform

Experimental research platform for studying how **LLM-driven synthetic personas** answer
survey questionnaires. Multiple personas (grounded, taxonomy-driven profiles) answer the
same questionnaire through the [OpenRouter](https://openrouter.ai) API; every response is
recorded with full experimental metadata so runs are reproducible and auditable.

> ⚠️ Synthetic personas are **not** a substitute for human respondents. This project follows
> a Train-Synthetic / Test-Real philosophy: synthetic runs are for hypothesis generation and
> option narrowing, and results must be validated on real human samples before any decision.

## Key features (planned)

- **Web dashboard** to define projects, questionnaires, personas and runs, and to follow
  persona answers in near-real time. Personas are scoped to projects (each research
  project has its own persona set, with application domain and target population
  recorded per the transparency checklist).
- **Seeding**: `npx tsx scripts/seed.ts <seed.json>` loads a project + personas
  definition idempotently (see script header for the JSON shape).
- **Full response recording**: every model call is stored with prompt, permutation,
  model parameters, raw output and token usage.
- **Bias mitigation built in**: balanced permutation of answer options, Style C
  (distribution) elicitation, per-question memory reset, neutral option labels.
- **Token budget tracking** per run / per persona / global, with hard stops.
- **Simple auth** (env-based credentials for the single-researcher phase).

## Stack

- Node.js + TypeScript, SQLite for storage (runs on a Raspberry Pi 5)
- OpenRouter API for model access (multi-model comparisons)
- Web UI served by the same Node process

## Getting started

```bash
cp .env.example .env   # fill in OPENROUTER_API_KEY and auth credentials
npm install
npm run dev            # http://localhost:3555
```

Requires Node.js 24+ (uses the built-in `node:sqlite` — no native modules).

Run tests with `npm test` (50 tests) or `npm run test:coverage`.

For production, a systemd user service works well:

```ini
[Unit]
Description=as-you-said AI persona survey platform
After=network-online.target

[Service]
WorkingDirectory=/path/to/as-you-said-ai-persona
ExecStart=npx tsx src/main.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

The default model list lives in `config/models.json` (default:
`deepseek/deepseek-v4-flash-0731`); the model is selectable per run in the UI.

## Methodology

The experimental protocol (persona grounding, elicitation format, bias mitigations,
validation) is documented in [docs/RESEARCH-DESIGN.md](docs/RESEARCH-DESIGN.md).

## License

[MIT](LICENSE) — free to reuse and adapt.
