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

export interface ChatClient {
  complete(model: string, prompt: string, opts: { temperature: number; seed: number }): Promise<ChatResult>
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
    prompt: string,
    opts: { temperature: number; seed: number }
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
    prompt: string,
    opts: { temperature: number; seed: number }
  ): Promise<ChatResult> {
    const started = Date.now()
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature,
        seed: opts.seed,
        usage: { include: true }
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
}
