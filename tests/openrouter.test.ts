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
})
