import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Memory from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MemoryStore } from '../src/store.ts'

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

describe('memory health stats', () => {
  it('summarizes active, archive, scope, key, pin and stale state', () => {
    const store = new MemoryStore(':memory:')

    store.write(
      'critical global preference',
      '',
      true,
      5,
      'global',
      'user.preference',
    )
    const archived = store.write(
      'old archived fact',
      '',
      false,
      2,
      'global',
      'old.fact',
    )
    store.archive(archived.id)
    store.write(
      'ordinary project fact',
      '',
      false,
      2,
      'project:test',
      '',
    )

    const future = Date.now() + 200 * 86_400_000
    const stats = store.stats(120, '*', future)

    expect(stats.total).toBe(3)
    expect(stats.active).toBe(2)
    expect(stats.archived).toBe(1)
    expect(stats.pinned).toBe(1)
    expect(stats.keyed).toBe(1)
    expect(stats.stale).toBe(1)

    expect(stats.scopes).toEqual(expect.arrayContaining([
      { scope: 'global', active: 1, archived: 1 },
      { scope: 'project:test', active: 1, archived: 0 },
    ]))
    expect(stats.importance).toEqual(expect.arrayContaining([
      { importance: 5, active: 1 },
      { importance: 2, active: 1 },
    ]))

    store.close()
  })

  it('supports an exact scope filter', () => {
    const store = new MemoryStore(':memory:')
    store.write('global fact', '', false, 3, 'global')
    store.write('project fact', '', false, 3, 'project:test')

    const stats = store.stats(120, 'project:test')
    expect(stats.total).toBe(1)
    expect(stats.active).toBe(1)
    expect(stats.scopes).toEqual([
      { scope: 'project:test', active: 1, archived: 0 },
    ])

    store.close()
  })
})

describe('memory_stats tool', () => {
  it('is registered and does not increment retrieval access counters', async () => {
    const ctx = await harness()
    await call(ctx, 'memory_write', {
      text: 'Stats must not count as retrieval',
      key: 'test.stats',
    })

    const stats = await call(ctx, 'memory_stats', {})
    expect(stats.total).toBe(1)
    expect(stats.active).toBe(1)
    expect(stats.keyed).toBe(1)

    const found = await call(ctx, 'memory_search', {
      query: 'Stats retrieval',
    })
    expect(found.matches).toHaveLength(1)
    expect(found.matches[0].accessCount).toBe(1)

    await ctx.fiber.dispose()
  })
})
