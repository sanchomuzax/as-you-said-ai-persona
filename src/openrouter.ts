export interface ChatResult {
  content: string
  modelVersion: string
  promptTokens: number
  completionTokens: number
  costUsd: number
  cachedTokens: number
  /** Which upstream provider served the call (OpenRouter routes the same model to several). */
  provider: string | null
  cacheDiscountUsd: number
  requestId: string | null
  latencyMs: number
}

/**
 * `provider` pins the upstream provider. OpenRouter otherwise routes the same
 * model id to whichever provider is free, which breaks both prompt caching and
 * model pinning: providers differ in quantization and settings, so a run spread
 * across seven of them is not the single-model experiment it claims to be.
 */
export interface ChatOptions {
  temperature: number
  seed: number
  provider?: string | undefined
}

/** One turn of a conversation, in the provider's wire format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** One upstream endpoint OpenRouter currently routes a model to (issue #28). */
export interface CatalogEndpoint {
  /** The exact string `ChatOptions.provider` / `provider.order` expects to pin THIS variant. */
  tag: string
  providerName: string
  /** 'unknown' is OpenRouter saying it does not know — never a real level. */
  quantization: string
}

export interface ChatClient {
  /**
   * A bare string is the single-question case (a questionnaire cell, sent in a
   * fresh context). A message list is a conversation with memory — only the
   * interview mode uses it, and its results live in their own tables.
   */
  complete(model: string, prompt: string | readonly ChatMessage[], opts: ChatOptions): Promise<ChatResult>
  /**
   * Optional (issue #28): the provider dropdown's live catalog source. Not
   * every ChatClient needs to implement it — a test stub, for one — and a
   * caller must treat a missing method exactly like a network failure: the
   * catalog is unreachable, fall back to what the database has observed.
   */
  listEndpoints?(model: string): Promise<CatalogEndpoint[]>
}

/** Thin OpenRouter chat-completions client with retry/backoff. */
export class OpenRouterClient implements ChatClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async complete(
    model: string,
    prompt: string | readonly ChatMessage[],
    opts: ChatOptions
  ): Promise<ChatResult> {
    const maxAttempts = 3
    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.callOnce(model, prompt, opts)
      } catch (error) {
        lastError = error
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
        }
      }
    }
    throw new Error(`OpenRouter call failed after ${maxAttempts} attempts: ${String(lastError)}`)
  }

  private async callOnce(
    model: string,
    prompt: string | readonly ChatMessage[],
    opts: ChatOptions
  ): Promise<ChatResult> {
    const started = Date.now()
    const messages: readonly ChatMessage[] =
      typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature,
        seed: opts.seed,
        usage: { include: true },
        // allow_fallbacks: false — a silent fallback to another provider would
        // reintroduce exactly the routing spread this option exists to remove.
        ...(opts.provider ? { provider: { order: [opts.provider], allow_fallbacks: false } } : {})
      })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = (await res.json()) as {
      id?: string
      model?: string
      provider?: string
      choices?: Array<{ message?: { content?: string } }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        cost?: number
        prompt_tokens_details?: { cached_tokens?: number }
        cache_discount?: number
      }
    }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('OpenRouter response missing content')
    return {
      content,
      // model PINNING: record the exact version string the API reports
      modelVersion: data.model ?? model,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      costUsd: data.usage?.cost ?? 0,
      cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      provider: data.provider ?? null,
      cacheDiscountUsd: data.usage?.cache_discount ?? 0,
      requestId: data.id ?? null,
      latencyMs: Date.now() - started
    }
  }

  /**
   * OpenRouter's endpoint list for one model: every upstream provider
   * currently serving it, with the exact slug to pin it (`tag`, e.g.
   * `deepinfra/fp4` — NOT the display name `DeepInfra`, which `provider.order`
   * does not reliably resolve) and its quantization. Bounded by a short
   * timeout and never retried: this backs an optional UI convenience (issue
   * #28's provider dropdown), not a measurement — a slow OpenRouter must not
   * stall the form that's asking for it.
   */
  async listEndpoints(model: string): Promise<CatalogEndpoint[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await this.fetchFn(`${this.baseUrl}/models/${model}/endpoints`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}`)
      }
      const data = (await res.json()) as {
        data?: {
          endpoints?: Array<{ tag?: string; provider_name?: string; quantization?: string }>
        }
      }
      // An endpoint with no tag has nothing a run could actually pin — offering
      // it would recreate the exact "type in a value that doesn't work" defect
      // this catalog exists to fix.
      return (data.data?.endpoints ?? [])
        .filter((e): e is { tag: string; provider_name?: string; quantization?: string } => !!e.tag)
        .map((e) => ({
          tag: e.tag,
          providerName: e.provider_name ?? e.tag,
          quantization: e.quantization ?? 'unknown'
        }))
    } finally {
      clearTimeout(timeout)
    }
  }
}
