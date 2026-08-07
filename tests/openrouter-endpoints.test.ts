import { describe, it, expect, vi } from 'vitest'
import { OpenRouterClient } from '../src/openrouter.js'

/**
 * Issue #28: the provider dropdown's catalog source. Separate file from
 * openrouter.test.ts (not to be edited) — this only exercises the new
 * `listEndpoints` method, added alongside `complete` without touching it.
 */
describe('OpenRouterClient.listEndpoints', () => {
  it('maps OpenRouter endpoints to tag/providerName/quantization', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe('https://example.test/v1/models/deepseek/deepseek-chat/endpoints')
      return new Response(
        JSON.stringify({
          data: {
            id: 'deepseek/deepseek-chat',
            endpoints: [
              { provider_name: 'DeepInfra', tag: 'deepinfra/fp4', quantization: 'fp4' },
              { provider_name: 'Azure', tag: 'azure', quantization: 'unknown' }
            ]
          }
        }),
        { status: 200 }
      )
    })
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as unknown as typeof fetch)
    const endpoints = await client.listEndpoints!('deepseek/deepseek-chat')
    expect(endpoints).toEqual([
      { tag: 'deepinfra/fp4', providerName: 'DeepInfra', quantization: 'fp4' },
      { tag: 'azure', providerName: 'Azure', quantization: 'unknown' }
    ])
  })

  it('throws on a non-OK response instead of returning a partial list', async () => {
    const fetchFn = vi.fn(async () => new Response('boom', { status: 500 }))
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as unknown as typeof fetch)
    await expect(client.listEndpoints!('m')).rejects.toThrow()
  })

  it('drops endpoints with no tag rather than offering an unusable pin value', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { endpoints: [{ provider_name: 'NoTag', quantization: 'fp8' }] } }), {
          status: 200
        })
    )
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as unknown as typeof fetch)
    expect(await client.listEndpoints!('m')).toEqual([])
  })

  it('returns an empty list for a model the catalog does not carry endpoints for', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const client = new OpenRouterClient('key', 'https://example.test/v1', fetchFn as unknown as typeof fetch)
    expect(await client.listEndpoints!('m')).toEqual([])
  })
})
