/**
 * Durable cross-session memory. The model writes facts with `memory_write`,
 * retrieves them with `memory_search`, and drops them with `memory_forget`;
 * a prompt section renders pinned and recent memories into every request so
 * recall does not depend on the model remembering to search.
 *
 * Storage is one local SQLite file with an FTS5 index — no embedding service,
 * no API key, no sidecar process.
 * @module dsh-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MemoryStore, normalizeTags } from './store.ts'
import type { MemoryRecord } from './store.ts'

export type * from './store.ts'

export const name = 'memory'
export const inject = ['tools', 'systemPrompt']

/** Plugin config. Every bound is a field: none of these are safe to hardcode across deployments. */
export interface Config {
  /**
   * SQLite file for this deployment's memories, or `:memory:` for an ephemeral
   * store. Required: a code-side default would silently scatter durable user
   * facts into whatever directory the harness happened to start in. The shipped
   * bundle patch supplies `dshHomePath('memory/memory.db')`.
   */
  path: string
  /** Unpinned recent memories rendered in the prompt section. */
  promptRecentCount: number
  /** Cap on the rendered prompt section; memories past it are dropped, pinned ones first to survive. */
  promptMaxChars: number
  /** Maximum characters accepted for one memory. */
  maxTextChars: number
  /** Default `limit` for `memory_search` when the model omits it. */
  searchLimitDefault: number
  /** Hard cap on `memory_search` results, whatever the model asks for. */
  searchLimitMax: number
  /** Prompt-section order; `-100` is the harness identity and `0` the persona. */
  promptOrder: number
  /** Similarity at/above which memory_write suppresses a likely duplicate. */
  dedupSimilarityThreshold: number
  /** Similarity at/above which memory_review reports a pair. */
  reviewSimilarityThreshold: number
  /** Maximum memories inspected by one memory_review pass. */
  reviewScanLimit: number
}

export const Config: z<Config> = z.object({
  path: z.string().required(),
  promptRecentCount: z.number().default(10),
  promptMaxChars: z.number().default(2000),
  maxTextChars: z.number().default(2000),
  searchLimitDefault: z.number().default(10),
  searchLimitMax: z.number().default(50),
  promptOrder: z.number().default(50),
  dedupSimilarityThreshold: z.number().default(0.9),
  reviewSimilarityThreshold: z.number().default(0.65),
  reviewScanLimit: z.number().default(1000),
})

const WRITE_DESCRIPTION =
  'Remember one durable fact across sessions: a user preference, a project convention, '
  + 'a decision and its reason, or a hard-won detail about this codebase. Write one self-contained '
  + 'fact per call — it will be read back with no surrounding conversation. Do NOT store transient '
  + 'task state (use the todo list), secrets, or anything the repository already records.'

const UPDATE_DESCRIPTION =
  'Correct or refine an existing durable memory in place instead of creating a stale second copy.'

const REVIEW_DESCRIPTION =
  'Review likely duplicate memories using deterministic local lexical similarity. This is read-only.'

const SEARCH_DESCRIPTION =
  'Search stored memories by keyword. Pinned and recent memories already appear in your context, '
  + 'so search when you need something older or more specific than what you can already see.'

const FORGET_DESCRIPTION =
  'Delete one stored memory by id, for a fact that is now wrong or obsolete. '
  + 'Ids come from memory_search or memory_write.'

/**
 * Render one memory as a prompt line.
 * @param record - the memory to render.
 * @returns a single line carrying the id, tags, and text.
 */
function promptLine(record: MemoryRecord): string {
  const tags = record.tags.length > 0 ? ` [${record.tags}]` : ''
  return `- (#${record.id}${record.pinned ? ', pinned' : ''})${tags} ${record.text}`
}

/**
 * Render the prompt section body under a character budget. Pinned memories are
 * emitted first, so a budget too small for everything keeps what the deployment
 * explicitly marked as always-relevant.
 * @param records - pinned records followed by recent ones.
 * @param maxChars - the budget.
 * @returns the section text, or an empty string when nothing fits or nothing is stored.
 */
function renderPrompt(records: readonly MemoryRecord[], maxChars: number): string {
  if (records.length === 0) return ''
  const header = 'Memories you previously stored (use memory_search for anything not listed):\n'
  const lines: string[] = []
  let used = header.length
  let dropped = 0
  for (const record of records) {
    const line = promptLine(record)
    if (used + line.length + 1 > maxChars) { dropped++; continue }
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return ''
  const tail = dropped > 0 ? `\n(${dropped} more memories not shown; use memory_search)` : ''
  return header + lines.join('\n') + tail
}

/**
 * Validate the bounds the schema cannot express, so an unusable configuration
 * fails at plugin load rather than at the first tool call.
 * @param config - the schema-validated config.
 * @throws when a bound is not a positive integer, or the default search limit exceeds its cap.
 */
function validateConfig(config: Config): void {
  const bounds = [
    ['promptRecentCount', config.promptRecentCount], ['promptMaxChars', config.promptMaxChars],
    ['maxTextChars', config.maxTextChars], ['searchLimitDefault', config.searchLimitDefault],
    ['searchLimitMax', config.searchLimitMax],
  ] as const
  for (const [field, value] of bounds) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`memory: invalid ${field} ${value} — must be an integer >= 1`)
    }
  }
  if (config.searchLimitDefault > config.searchLimitMax) {
    throw new Error(
      `memory: searchLimitDefault ${config.searchLimitDefault} exceeds searchLimitMax ${config.searchLimitMax}`)
  }
  for (const [field, value] of [
    ['dedupSimilarityThreshold', config.dedupSimilarityThreshold],
    ['reviewSimilarityThreshold', config.reviewSimilarityThreshold],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`memory: invalid ${field} ${value} — must be > 0 and <= 1`)
    }
  }
  if (config.reviewSimilarityThreshold > config.dedupSimilarityThreshold) {
    throw new Error('memory: reviewSimilarityThreshold must be <= dedupSimilarityThreshold')
  }
  if (!Number.isInteger(config.reviewScanLimit) || config.reviewScanLimit < 1) {
    throw new Error(`memory: invalid reviewScanLimit ${config.reviewScanLimit} — must be an integer >= 1`)
  }
  if (config.path.length === 0) throw new Error('memory: `path` must not be empty')
}

function mergeTagStrings(left: string, right: string): string {
  return normalizeTags([...left.split(' '), ...right.split(' ')])
}

/**
 * Open the store, register the three tools, and contribute the recall section.
 * @param ctx - plugin context; the store, tools, and section are disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)

  let store: MemoryStore | undefined
  ctx.effect(() => {
    store = new MemoryStore(config.path)
    return () => {
      store?.close()
      store = undefined
    }
  })

  /**
   * The open store, or a loud failure. Reached only while the fiber is active,
   * so an absent store is a lifecycle bug rather than an expected state.
   * @returns the live store.
   */
  function open(): MemoryStore {
    if (!store) throw new Error('memory: store is not open')
    return store
  }

  ctx.systemPrompt.section({
    name: 'memory:recall',
    order: config.promptOrder,
    text: () => renderPrompt(open().forPrompt(config.promptRecentCount), config.promptMaxChars),
  })

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: WRITE_DESCRIPTION,
    parameters: {
      text: { type: 'string', required: true, description: 'The self-contained fact to remember.' },
      tags: {
        type: 'array',
        description: 'Optional labels for later retrieval, e.g. ["preference", "build"].',
        items: { type: 'string' },
      },
      pinned: {
        type: 'boolean',
        description: 'Always show this memory in context. Reserve it for facts that matter in every session.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', required: true },
          tags: { type: 'string', required: true },
          pinned: { type: 'boolean', required: true },
          deduplicated: { type: 'boolean', required: true },
          similarity: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.deduplicated
          ? `Reused existing memory #${value.id} instead of storing a duplicate.`
          : `Stored memory #${value.id}${value.pinned ? ' (pinned)' : ''}.`,
      }],
    },
    presentCall: args => ({ card: 'generic', title: 'memory_write', kind: 'edit', rawInput: args }),
    async execute(args) {
      const text = args.text.trim()
      // Bounds the schema DSL cannot express: a non-empty fact, under the cap.
      if (text.length === 0) throw new Error('memory_write: `text` must not be blank')
      if (text.length > config.maxTextChars) {
        throw new Error(`memory_write: \`text\` is ${text.length} chars, over the ${config.maxTextChars} limit`)
      }
      const tags = normalizeTags(args.tags ?? [])
      const pinned = args.pinned ?? false

      const exact = open().findExact(text)
      if (exact) {
        const merged = open().update(exact.id, {
          tags: mergeTagStrings(exact.tags, tags),
          pinned: exact.pinned || pinned,
        }) ?? exact
        return { id: merged.id, tags: merged.tags, pinned: merged.pinned, deduplicated: true, similarity: 1 }
      }

      const similar = open().findSimilar(text, config.dedupSimilarityThreshold, 1)[0]
      if (similar) {
        const merged = open().update(similar.record.id, {
          tags: mergeTagStrings(similar.record.tags, tags),
          pinned: similar.record.pinned || pinned,
        }) ?? similar.record
        return {
          id: merged.id,
          tags: merged.tags,
          pinned: merged.pinned,
          deduplicated: true,
          similarity: similar.similarity,
        }
      }

      const record = open().write(text, tags, pinned)
      return { id: record.id, tags: record.tags, pinned: record.pinned, deduplicated: false }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_update',
    description: UPDATE_DESCRIPTION,
    parameters: {
      id: { type: 'integer', required: true, description: 'The memory id to update.' },
      text: { type: 'string', description: 'Replacement self-contained durable fact.' },
      tags: { type: 'array', description: 'Replacement labels.', items: { type: 'string' } },
      pinned: { type: 'boolean', description: 'Replacement pinned state.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', required: true },
          updated: { type: 'boolean', required: true },
          text: { type: 'string' },
          tags: { type: 'string' },
          pinned: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.updated ? `Updated memory #${value.id}.` : `No memory #${value.id} to update.`,
      }],
    },
    presentCall: args => ({ card: 'generic', title: `memory_update #${args.id}`, kind: 'edit', rawInput: args }),
    async execute(args) {
      if (args.text === undefined && args.tags === undefined && args.pinned === undefined) {
        throw new Error('memory_update: provide at least one field to change')
      }

      let text: string | undefined
      if (args.text !== undefined) {
        text = args.text.trim()
        if (text.length === 0) throw new Error('memory_update: `text` must not be blank')
        if (text.length > config.maxTextChars) {
          throw new Error(`memory_update: \`text\` is ${text.length} chars, over the ${config.maxTextChars} limit`)
        }
        const exact = open().findExact(text, args.id)
        if (exact) throw new Error(`memory_update: replacement text duplicates memory #${exact.id}`)
        const similar = open().findSimilar(text, config.dedupSimilarityThreshold, 1, args.id)[0]
        if (similar) {
          throw new Error(`memory_update: replacement is too similar to memory #${similar.record.id}`)
        }
      }

      const patch: { text?: string; tags?: string; pinned?: boolean } = {}
      if (text !== undefined) patch.text = text
      if (args.tags !== undefined) patch.tags = normalizeTags(args.tags)
      if (args.pinned !== undefined) patch.pinned = args.pinned

      const record = open().update(args.id, patch)
      if (!record) return { id: args.id, updated: false }
      return { id: record.id, updated: true, text: record.text, tags: record.tags, pinned: record.pinned }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords to look for in memory text and tags.' },
      limit: { type: 'number', description: `Maximum results. Defaults to ${config.searchLimitDefault}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                text: { type: 'string', required: true },
                tags: { type: 'string', required: true },
                pinned: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.matches.length === 0
          ? `No memories match ${JSON.stringify(args.query)}.`
          : value.matches.map(match => promptLine({ ...match, createdAt: 0, updatedAt: 0 })).join('\n'),
      }],
      presentationMeta: (_args, value) => ({ count: value.matches.length }),
    },
    presentCall: args => ({ card: 'generic', title: `memory_search ${args.query}`, kind: 'search' }),
    async execute(args) {
      const requested = args.limit ?? config.searchLimitDefault
      if (!Number.isInteger(requested) || requested < 1) {
        throw new Error(`memory_search: \`limit\` must be an integer >= 1 (got ${requested})`)
      }
      const matches = open().search(args.query, Math.min(requested, config.searchLimitMax))
      return {
        matches: matches.map(({ id, text, tags, pinned }) => ({ id, text, tags, pinned })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_review',
    description: REVIEW_DESCRIPTION,
    parameters: {
      limit: { type: 'number', description: `Maximum pairs. Defaults to ${config.searchLimitDefault}.` },
      similarity: { type: 'number', description: `Threshold. Defaults to ${config.reviewSimilarityThreshold}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scanned: { type: 'integer', required: true },
          pairs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                leftId: { type: 'integer', required: true },
                rightId: { type: 'integer', required: true },
                similarity: { type: 'number', required: true },
                leftText: { type: 'string', required: true },
                rightText: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Found ${value.pairs.length} likely duplicate pair(s) while reviewing ${value.scanned} memories.`,
      }],
      presentationMeta: (_args, value) => ({ count: value.pairs.length }),
    },
    presentCall: args => ({ card: 'generic', title: 'memory_review', kind: 'search', rawInput: args }),
    async execute(args) {
      const requested = args.limit ?? config.searchLimitDefault
      if (!Number.isInteger(requested) || requested < 1) {
        throw new Error(`memory_review: \`limit\` must be an integer >= 1 (got ${requested})`)
      }
      const similarity = args.similarity ?? config.reviewSimilarityThreshold
      if (!Number.isFinite(similarity) || similarity <= 0 || similarity > 1) {
        throw new Error(`memory_review: \`similarity\` must be > 0 and <= 1 (got ${similarity})`)
      }
      const pairs = open().review(
        similarity,
        config.reviewScanLimit,
        Math.min(requested, config.searchLimitMax),
      )
      return {
        scanned: Math.min(open().count(), config.reviewScanLimit),
        pairs: pairs.map(pair => ({
          leftId: pair.left.id,
          rightId: pair.right.id,
          similarity: pair.similarity,
          leftText: pair.left.text,
          rightText: pair.right.text,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: FORGET_DESCRIPTION,
    parameters: {
      id: { type: 'integer', required: true, description: 'The memory id to delete.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'integer', required: true }, forgotten: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        // A miss is a successful domain result, not an infrastructure failure:
        // the model asked for a state that already holds.
        text: value.forgotten ? `Forgot memory #${value.id}.` : `No memory #${value.id} to forget.`,
      }],
    },
    async execute(args) {
      return { id: args.id, forgotten: open().forget(args.id) }
    },
  }))
}
