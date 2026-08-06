# as-you-said — AI Persona Survey Research Platform

Experimental research platform for studying how **LLM-driven synthetic personas** answer
survey questionnaires. Multiple personas (grounded, taxonomy-driven profiles) answer the
same questionnaire through the [OpenRouter](https://openrouter.ai) API; every response is
recorded with full experimental metadata so runs are reproducible and auditable.

> ⚠️ Synthetic personas are **not** a substitute for human respondents. This project follows
> a Train-Synthetic / Test-Real philosophy: synthetic runs are for hypothesis generation and
> option narrowing, and results must be validated on real human samples before any decision.

## Key features (planned)

- **Web dashboard** to define questionnaires, personas and runs, and to follow persona
  answers in near-real time.
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
npm run dev
```

## Methodology

The experimental protocol (persona grounding, elicitation format, bias mitigations,
validation) is documented in [docs/RESEARCH-DESIGN.md](docs/RESEARCH-DESIGN.md).

## License

[MIT](LICENSE) — free to reuse and adapt.
