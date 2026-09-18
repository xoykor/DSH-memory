import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Memory from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MemoryStore, lexicalSimilarity, normalizeMemoryText } from '../src/store.ts'

async function harness(config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Tools, {})
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Memory, { path: ':memory:', ...config } as Config)
  return ctx
}

async function call(ctx: Context, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await ctx.tools.execute({
    name,
    arguments: args,
    signal: new AbortController().signal,
  } as never)
  if (result.isError) throw new Error(result.error.message)
  return result.value
}

describe('deterministic curation primitives', () => {
  it('normalizes formatting and computes lexical similarity', () => {
    expect(normalizeMemoryText(' Uses  CachyOS — KDE! ')).toBe('uses cachyos kde')
    expect(lexicalSimilarity('uses cachyos kde', 'Uses CachyOS KDE!')).toBe(1)
  })

  it('updates in place and keeps FTS synchronized', () => {
    const store = new MemoryStore(':memory:')
    const memory = store.write('Use npm for builds', 'build', false)
    const changed = store.update(memory.id, { text: 'Use pnpm for builds' })

    expect(changed?.id).toBe(memory.id)
    expect(store.search('npm', 10)).toEqual([])
    expect(store.search('pnpm', 10)[0]?.id).toBe(memory.id)
    store.close()
  })

  it('reviews similar memories without mutating them', () => {
    const store = new MemoryStore(':memory:')
    store.write('User prefers fish shell on CachyOS', '', false)
    store.write('User prefers the fish shell on CachyOS', '', false)
    store.write('Unrelated note about coffee', '', false)

    const pairs = store.review(0.7, 100, 10)
    expect(pairs).toHaveLength(1)
    expect(store.count()).toBe(3)
    store.close()
  })
})

describe('model-facing curation tools', () => {
  it('registers update and review', async () => {
    const ctx = await harness()
    expect(ctx.tools.get('memory_update')).toBeDefined()
    expect(ctx.tools.get('memory_review')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('suppresses an exact normalized duplicate and merges metadata', async () => {
    const ctx = await harness()
    const first = await call(ctx, 'memory_write', {
      text: 'User prefers fish shell',
      tags: ['shell'],
    })
    const second = await call(ctx, 'memory_write', {
      text: ' user prefers FISH shell! ',
      tags: ['preference'],
      pinned: true,
    })

    expect(second.id).toBe(first.id)
    expect(second.deduplicated).toBe(true)
    expect(second.similarity).toBe(1)
    expect(second.tags).toContain('shell')
    expect(second.tags).toContain('preference')
    expect(second.pinned).toBe(true)
    await ctx.fiber.dispose()
  })

  it('changes a durable fact through memory_update', async () => {
    const ctx = await harness()
    const created = await call(ctx, 'memory_write', { text: 'Project uses Node 22' })
    const updated = await call(ctx, 'memory_update', {
      id: created.id,
      text: 'Project uses Node 24',
    })
    const found = await call(ctx, 'memory_search', { query: 'Node 24' })

    expect(updated.updated).toBe(true)
    expect(updated.id).toBe(created.id)
    expect(found.matches).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('reports likely duplicates through memory_review', async () => {
    const ctx = await harness({ dedupSimilarityThreshold: 1 })
    await call(ctx, 'memory_write', { text: 'User prefers fish shell on CachyOS' })
    await call(ctx, 'memory_write', { text: 'User prefers the fish shell on CachyOS' })

    const reviewed = await call(ctx, 'memory_review', { similarity: 0.7 })
    expect(reviewed.pairs).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
