import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Memory from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * Plugin-level suite: registration against the real tool registry and prompt
 * service, the fail-loud config contract, and the round trip from a
 * `memory_write` call to the text the recall section renders.
 */

/** Boot the tool registry, the prompt service, and the plugin under test. */
async function harness(config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Tools, {})
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Memory, { path: ':memory:', ...config } as Config)
  return ctx
}

/** Execute one registered tool and return its canonical value. */
async function call(ctx: Context, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await ctx.tools.execute({ name, arguments: args, signal: new AbortController().signal } as never)
  if (result.isError) throw new Error(result.error.message)
  return result.value
}

describe('registration', () => {
  it('registers all model-facing memory tools', async () => {
    const ctx = await harness()

    expect(ctx.tools.get('memory_write')).toBeDefined()
    expect(ctx.tools.get('memory_update')).toBeDefined()
    expect(ctx.tools.get('memory_search')).toBeDefined()
    expect(ctx.tools.get('memory_stats')).toBeDefined()
    expect(ctx.tools.get('memory_review')).toBeDefined()
    expect(ctx.tools.get('memory_forget')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('unregisters everything when the plugin unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(Tools, {})
    await ctx.plugin(SystemPrompt, {})
    const fiber = ctx.plugin(Memory, { path: ':memory:' } as Config)
    await fiber

    expect(ctx.tools.get('memory_write')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('memory_write')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('memory policy prompt', () => {
  it('uses guided policy by default even before any memory exists', async () => {
    const ctx = await harness()

    const assembled = await ctx.systemPrompt.assemble({})
    const policy = assembled.sections.find(section => section.name === 'memory:policy')
    expect(policy?.text).toContain('Use memory_search')
    expect(policy?.text).toContain('Use memory_write')
    expect(policy?.text).toContain('Use memory_update')
    expect(policy?.text).toContain('Avoid memory tool calls')
    await ctx.fiber.dispose()
  })

  it('keeps minimal mode free of memory-usage instructions', async () => {
    const ctx = await harness({ memoryPolicy: 'minimal' })

    const assembled = await ctx.systemPrompt.assemble({})
    const policy = assembled.sections.find(section => section.name === 'memory:policy')
    expect(policy?.text ?? '').toBe('')
    await ctx.fiber.dispose()
  })

  it('makes strict mode explicitly check prior-session assumptions and durable writes', async () => {
    const ctx = await harness({ memoryPolicy: 'strict' })

    const assembled = await ctx.systemPrompt.assemble({})
    const policy = assembled.sections.find(section => section.name === 'memory:policy')
    expect(policy?.text).toContain('Before relying on an assumption')
    expect(policy?.text).toContain('Before finishing a task')
    expect(policy?.text).toContain('canonical key')
    await ctx.fiber.dispose()
  })
})

describe('write and recall round trip', () => {
  it('renders a written memory into the prompt section', async () => {
    const ctx = await harness()
    await call(ctx, 'memory_write', { text: 'The user prefers pnpm over npm', tags: ['Build'] })

    const assembled = await ctx.systemPrompt.assemble({})
    const text = assembled.sections.map(section => section.text).join('\n')
    expect(text).toContain('The user prefers pnpm over npm')
    expect(text).toContain('[build]')
    await ctx.fiber.dispose()
  })

  it('finds a written memory through memory_search', async () => {
    const ctx = await harness()
    await call(ctx, 'memory_write', { text: 'Release branch is called ship', tags: [] })
    const found = await call(ctx, 'memory_search', { query: 'release branch' }) as { matches: { text: string }[] }

    expect(found.matches.map(match => match.text)).toEqual(['Release branch is called ship'])
    await ctx.fiber.dispose()
  })

  it('reports a forget miss as a successful domain result', async () => {
    const ctx = await harness()
    const value = await call(ctx, 'memory_forget', { id: 4242 }) as { forgotten: boolean }

    expect(value.forgotten).toBe(false)
    await ctx.fiber.dispose()
  })

  it('contributes no recall payload when no memory is stored', async () => {
    const ctx = await harness()

    const assembled = await ctx.systemPrompt.assemble({})
    expect(assembled.sections.some(section => section.name === 'memory:recall' && section.text.length > 0)).toBe(false)
    await ctx.fiber.dispose()
  })
})

describe('bounds', () => {
  it('rejects a blank fact', async () => {
    const ctx = await harness()
    await expect(call(ctx, 'memory_write', { text: '   ' })).rejects.toThrow('must not be blank')
    await ctx.fiber.dispose()
  })

  it('rejects a fact over maxTextChars', async () => {
    const ctx = await harness({ maxTextChars: 10 })
    await expect(call(ctx, 'memory_write', { text: 'x'.repeat(11) })).rejects.toThrow('over the 10 limit')
    await ctx.fiber.dispose()
  })

  it('clamps a search limit to searchLimitMax', async () => {
    const ctx = await harness({ searchLimitDefault: 2, searchLimitMax: 2 })
    for (let index = 0; index < 5; index++) {
      await call(ctx, 'memory_write', { text: `widget fact ${index}` })
    }
    const found = await call(ctx, 'memory_search', { query: 'widget', limit: 100 }) as { matches: unknown[] }

    expect(found.matches).toHaveLength(2)
    await ctx.fiber.dispose()
  })
})

describe('fail-loud config', () => {
  it('rejects a missing path', async () => {
    const ctx = new Context()
    await ctx.plugin(Tools, {})
    await ctx.plugin(SystemPrompt, {})
    await expect(ctx.plugin(Memory, {} as Config)).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects a default search limit above the cap', async () => {
    await expect(harness({ searchLimitDefault: 100, searchLimitMax: 10 }))
      .rejects.toThrow('exceeds searchLimitMax')
  })

  it('rejects an unknown memory policy', async () => {
    await expect(harness({ memoryPolicy: 'aggressive' as never })).rejects.toThrow()
  })

  it('rejects a non-positive bound', async () => {
    await expect(harness({ promptMaxChars: 0 })).rejects.toThrow('invalid promptMaxChars')
  })
})
