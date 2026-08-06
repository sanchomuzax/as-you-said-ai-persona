import { describe, it, expect, vi } from 'vitest'
import { OpenRouterClient } from '../src/openrouter.js'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

const successBody = {
  id: 'gen-123',
  model: 'deepseek/deepseek-v4-flash-20260801',
  choices: [{ message: { content: '{"A": 0.5, "B": 0.5}' } }],
  usage: { prompt_tokens: 42, completion_tokens: 7, cost: 0.00012 }
}

describe('OpenRouterClient', () => {
  it('sends the request and maps the response including exact model version', async () => {
    const fetchFn = vi.fn(async () => okResponse(successBody))
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as typeof fetch)
    const result = await client.complete('deepseek/deepseek-v4-flash', 'hello', { temperature: 1, seed: 0 })

    expect(result.content).toBe('{"A": 0.5, "B": 0.5}')
    expect(result.modelVersion).toBe('deepseek/deepseek-v4-flash-20260801')
    expect(result.promptTokens).toBe(42)
    expect(result.costUsd).toBeCloseTo(0.00012)
    expect(result.requestId).toBe('gen-123')

    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://example.test/v1/chat/completions')
    const payload = JSON.parse(String(init.body))
    expect(payload.model).toBe('deepseek/deepseek-v4-flash')
    expect(payload.seed).toBe(0)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key')
  })

  it('retries on HTTP errors and succeeds on a later attempt', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okResponse(successBody))
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as typeof fetch)
    const result = await client.complete('m', 'p', { temperature: 1, seed: 0 })
    expect(result.content).toContain('0.5')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  }, 15_000)

  it('fails after exhausting retries', async () => {
    const fetchFn = vi.fn(async () => new Response('boom', { status: 500 }))
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as typeof fetch)
    await expect(client.complete('m', 'p', { temperature: 1, seed: 0 })).rejects.toThrow(/failed after 3 attempts/)
  }, 15_000)

  it('rejects responses without content', async () => {
    const fetchFn = vi.fn(async () => okResponse({ choices: [] }))
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as typeof fetch)
    await expect(client.complete('m', 'p', { temperature: 1, seed: 0 })).rejects.toThrow(/missing content/)
  }, 15_000)

  it('includes cachedTokens and cacheDiscountUsd when present in usage', async () => {
    const bodyWithCache = {
      id: 'gen-124',
      model: 'deepseek/deepseek-v4-flash-20260801',
      choices: [{ message: { content: 'cached response' } }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        cost: 0.0001,
        prompt_tokens_details: { cached_tokens: 20 },
        cache_discount: -0.00005
      }
    }
    const fetchFn = vi.fn(async () => okResponse(bodyWithCache))
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as typeof fetch)
    const result = await client.complete('m', 'p', { temperature: 1, seed: 0 })

    expect(result.cachedTokens).toBe(20)
    expect(result.cacheDiscountUsd).toBeCloseTo(-0.00005)
  })

  it('defaults cachedTokens and cacheDiscountUsd to 0 when absent', async () => {
    const fetchFn = vi.fn(async () => okResponse(successBody))
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as typeof fetch)
    const result = await client.complete('m', 'p', { temperature: 1, seed: 0 })

    expect(result.cachedTokens).toBe(0)
    expect(result.cacheDiscountUsd).toBe(0)
  })

  it('defaults cachedTokens to 0 when prompt_tokens_details is present but cached_tokens is missing', async () => {
    const bodyWithPartialDetails = {
      id: 'gen-125',
      model: 'deepseek/deepseek-v4-flash-20260801',
      choices: [{ message: { content: 'response' } }],
      usage: {
        prompt_tokens: 42,
        completion_tokens: 7,
        cost: 0.00012,
        prompt_tokens_details: {} // present but empty
      }
    }
    const fetchFn = vi.fn(async () => okResponse(bodyWithPartialDetails))
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as typeof fetch)
    const result = await client.complete('m', 'p', { temperature: 1, seed: 0 })

    expect(result.cachedTokens).toBe(0)
    expect(result.cacheDiscountUsd).toBe(0)
  })

  it('handles null/undefined in usage gracefully', async () => {
    const bodyWithNullUsage = {
      id: 'gen-126',
      model: 'deepseek/deepseek-v4-flash-20260801',
      choices: [{ message: { content: 'response' } }],
      usage: null
    }
    const fetchFn = vi.fn(async () => okResponse(bodyWithNullUsage))
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as typeof fetch)
    const result = await client.complete('m', 'p', { temperature: 1, seed: 0 })

    expect(result.cachedTokens).toBe(0)
    expect(result.cacheDiscountUsd).toBe(0)
    expect(result.promptTokens).toBe(0)
    expect(result.costUsd).toBe(0)
  })
})

describe('OpenRouterClient — provider pinning', () => {
  it('sends no provider routing block when the run does not pin one', async () => {
    let sentBody: Record<string, unknown> = {}
    const fetchFn = (async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body) as Record<string, unknown>
      return {
        ok: true,
        json: async () => ({ id: 'r', model: 'm', choices: [{ message: { content: '{}' } }], usage: {} })
      }
    }) as unknown as typeof fetch
    const client = new OpenRouterClient('k', 'https://x', fetchFn)
    await client.complete('m', 'p', { temperature: 1, seed: 0 })
    expect(sentBody['provider']).toBeUndefined()
  })

  it('pins the provider and forbids fallback when the run asks for it', async () => {
    let sentBody: Record<string, unknown> = {}
    const fetchFn = (async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body) as Record<string, unknown>
      return {
        ok: true,
        json: async () => ({ id: 'r', model: 'm', provider: 'DeepInfra', choices: [{ message: { content: '{}' } }], usage: {} })
      }
    }) as unknown as typeof fetch
    const client = new OpenRouterClient('k', 'https://x', fetchFn)
    await client.complete('m', 'p', { temperature: 1, seed: 0, provider: 'DeepInfra' })
    // routing must be deterministic: one provider, no silent fallback to another
    expect(sentBody['provider']).toEqual({ order: ['DeepInfra'], allow_fallbacks: false })
  })
})
