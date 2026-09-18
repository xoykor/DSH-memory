/**
 * Durable curated cross-session memory for DeepSeek Harness.
 *
 * Storage is one local SQLite/FTS5 database. Curation is deterministic: no
 * embedding service, API key, sidecar process or second model.
 * @module dsh-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  MemoryStore,
  lexicalSimilarity,
  normalizeMemoryKey,
  normalizeMemoryText,
  normalizeScope,
  normalizeTags,
} from './store.ts'
import type { MemoryRecord } from './store.ts'

export type * from './store.ts'

export const name = 'memory'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  path: string
  /** Number of non-pinned memories selected by deterministic recall ranking. */
  promptRecentCount: number
  /** Character budget for the memory prompt section. */
  promptMaxChars: number
  /** Maximum characters accepted for one memory. */
  maxTextChars: number
  searchLimitDefault: number
  searchLimitMax: number
  promptOrder: number

  dedupSimilarityThreshold: number
  reviewSimilarityThreshold: number
  reviewScanLimit: number

  /** Scope used when memory_write omits scope. */
  defaultScope: string
  /** Active scope for automatic prompt recall. Non-global scopes also see global memories. */
  promptScope: string
  /** Half-life of the recall recency bonus. */
  decayHalfLifeDays: number
  /** Age after which low/normal importance memories can appear as stale review candidates. */
  staleAfterDays: number
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

  defaultScope: z.string().default('global'),
  promptScope: z.string().default('global'),
  decayHalfLifeDays: z.number().default(45),
  staleAfterDays: z.number().default(120),
})

const WRITE_DESCRIPTION =
  'Remember one self-contained durable fact across sessions. Store preferences, project conventions, '
  + 'decisions/reasons, or hard-won environment details. Do NOT store transient task state, secrets, '
  + 'or facts already available in the repository. Use importance 1-5 deliberately: 3 is normal; '
  + '5 is reserved for durable facts that should resist stale review. Use scopes such as global, '
  + 'project:<name>, or workspace:<name>. When a fact has one canonical identity, optionally give it '
  + 'a stable key such as environment.shell or project.runtime.'

const UPDATE_DESCRIPTION =
  'Correct or refine an existing durable memory in place. Prefer this over creating a stale second copy. '
  + 'Set archived=true to remove a memory from normal recall without deleting it; set archived=false to restore it.'

const REVIEW_DESCRIPTION =
  'Review likely duplicate and stale memories using deterministic local metadata. '
  + 'This tool is read-only; use memory_update or memory_forget to apply curation.'

const SEARCH_DESCRIPTION =
  'Search stored memories by keyword. Search results count as explicit accesses and therefore receive '
  + 'a small future recall bonus. Omit scope to search all scopes.'

const STATS_DESCRIPTION =
  'Inspect memory health without changing retrieval counters: active/archive counts, pinned/keyed totals, '
  + 'stale candidates, scopes, and active memories by importance.'

const FORGET_DESCRIPTION =
  'Delete one stored memory by id when the fact is wrong, obsolete, or intentionally discarded.'

function promptLine(record: MemoryRecord): string {
  const tags = record.tags.length > 0 ? ` [${record.tags}]` : ''
  const meta: string[] = []
  if (record.pinned) meta.push('pinned')
  if (record.importance !== 3) meta.push(`importance=${record.importance}`)
  if (record.scope !== 'global') meta.push(`scope=${record.scope}`)
  if (record.key.length > 0) meta.push(`key=${record.key}`)
  const suffix = meta.length > 0 ? `, ${meta.join(', ')}` : ''
  return `- (#${record.id}${suffix})${tags} ${record.text}`
}

function renderPrompt(records: readonly MemoryRecord[], maxChars: number): string {
  if (records.length === 0) return ''
  const header = 'Durable memories (use memory_search for anything not listed):\n'
  const lines: string[] = []
  let used = header.length
  let dropped = 0

  for (const record of records) {
    const line = promptLine(record)
    if (used + line.length + 1 > maxChars) {
      dropped++
      continue
    }
    lines.push(line)
    used += line.length + 1
  }

  if (lines.length === 0) return ''
  const tail = dropped > 0
    ? `\n(${dropped} more selected memories did not fit; use memory_search)`
    : ''
  return header + lines.join('\n') + tail
}

function validateImportance(value: number, tool: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${tool}: \`importance\` must be an integer from 1 to 5 (got ${value})`)
  }
  return value
}

function validateScope(value: string, tool: string): string {
  if (value === '*') return value
  const normalized = normalizeScope(value)
  if (normalized.length === 0) throw new Error(`${tool}: \`scope\` must not be blank`)
  if (normalized.length > 120) throw new Error(`${tool}: \`scope\` must be at most 120 characters`)
  return normalized
}

function validateKey(value: string, tool: string): string {
  if (value.trim().length === 0) return ''
  const normalized = normalizeMemoryKey(value)
  if (normalized.length === 0) {
    throw new Error(`${tool}: \`key\` contains no usable characters`)
  }
  if (normalized.length > 120) {
    throw new Error(`${tool}: \`key\` must be at most 120 characters`)
  }
  return normalized
}

function validateConfig(config: Config): void {
  const integerBounds = [
    ['promptRecentCount', config.promptRecentCount],
    ['promptMaxChars', config.promptMaxChars],
    ['maxTextChars', config.maxTextChars],
    ['searchLimitDefault', config.searchLimitDefault],
    ['searchLimitMax', config.searchLimitMax],
    ['reviewScanLimit', config.reviewScanLimit],
    ['staleAfterDays', config.staleAfterDays],
  ] as const

  for (const [field, value] of integerBounds) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`memory: invalid ${field} ${value} — must be an integer >= 1`)
    }
  }

  if (config.searchLimitDefault > config.searchLimitMax) {
    throw new Error(
      `memory: searchLimitDefault ${config.searchLimitDefault} exceeds searchLimitMax ${config.searchLimitMax}`,
    )
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

  if (!Number.isFinite(config.decayHalfLifeDays) || config.decayHalfLifeDays <= 0) {
    throw new Error(
      `memory: invalid decayHalfLifeDays ${config.decayHalfLifeDays} — must be > 0`,
    )
  }

  if (config.path.length === 0) throw new Error('memory: `path` must not be empty')
  validateScope(config.defaultScope, 'memory config defaultScope')
  validateScope(config.promptScope, 'memory config promptScope')
}

function mergeTagStrings(left: string, right: string): string {
  return normalizeTags([...left.split(' '), ...right.split(' ')])
}

export function apply(ctx: Context, config: Config): void {
  validateConfig(config)

  const defaultScope = validateScope(config.defaultScope, 'memory config defaultScope')
  const promptScope = validateScope(config.promptScope, 'memory config promptScope')

  let store: MemoryStore | undefined
  ctx.effect(() => {
    store = new MemoryStore(config.path)
    return () => {
      store?.close()
      store = undefined
    }
  })

  function open(): MemoryStore {
    if (!store) throw new Error('memory: store is not open')
    return store
  }

  ctx.systemPrompt.section({
    name: 'memory:recall',
    order: config.promptOrder,
    text: () => renderPrompt(
      open().forPrompt(
        config.promptRecentCount,
        promptScope,
        config.decayHalfLifeDays,
      ),
      config.promptMaxChars,
    ),
  })

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: WRITE_DESCRIPTION,
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The self-contained durable fact to remember.',
      },
      tags: {
        type: 'array',
        description: 'Optional labels for later retrieval, e.g. ["preference", "build"].',
        items: { type: 'string' },
      },
      pinned: {
        type: 'boolean',
        description: 'Always include this memory in recall for its visible scope.',
      },
      importance: {
        type: 'number',
        description: 'Durability/relevance from 1 to 5. Defaults to 3.',
      },
      scope: {
        type: 'string',
        description: `Memory scope. Defaults to ${JSON.stringify(defaultScope)}.`,
      },
      key: {
        type: 'string',
        description: 'Optional canonical key unique among active memories in this scope.',
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
          importance: { type: 'integer', required: true },
          scope: { type: 'string', required: true },
          key: { type: 'string', required: true },
          deduplicated: { type: 'boolean', required: true },
          conflict: { type: 'boolean', required: true },
          existingText: { type: 'string' },
          similarity: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.conflict
          ? `Canonical key ${value.key} in ${value.scope} already belongs to memory #${value.id} with different text; use memory_update explicitly if the fact changed.`
          : value.deduplicated
            ? `Reused memory #${value.id} in ${value.scope} instead of storing a duplicate.`
            : `Stored memory #${value.id} in ${value.scope}.`,
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: 'memory_write',
      kind: 'edit',
      rawInput: args,
    }),
    async execute(args) {
      const text = args.text.trim()
      if (text.length === 0) throw new Error('memory_write: `text` must not be blank')
      if (text.length > config.maxTextChars) {
        throw new Error(
          `memory_write: \`text\` is ${text.length} chars, over the ${config.maxTextChars} limit`,
        )
      }

      const tags = normalizeTags(args.tags ?? [])
      const pinned = args.pinned ?? false
      const importance = validateImportance(args.importance ?? 3, 'memory_write')
      const scope = validateScope(args.scope ?? defaultScope, 'memory_write')
      const key = args.key === undefined ? '' : validateKey(args.key, 'memory_write')

      if (key.length > 0) {
        const keyed = open().findByKey(key, scope)
        if (keyed) {
          const similarity = lexicalSimilarity(text, keyed.text)
          if (
            normalizeMemoryText(text) === normalizeMemoryText(keyed.text)
            || similarity >= config.dedupSimilarityThreshold
          ) {
            const merged = open().update(keyed.id, {
              tags: mergeTagStrings(keyed.tags, tags),
              pinned: keyed.pinned || pinned,
              importance: Math.max(keyed.importance, importance),
            }) ?? keyed
            return {
              id: merged.id,
              tags: merged.tags,
              pinned: merged.pinned,
              importance: merged.importance,
              scope: merged.scope,
              key: merged.key,
              deduplicated: true,
              conflict: false,
              similarity,
            }
          }

          return {
            id: keyed.id,
            tags: keyed.tags,
            pinned: keyed.pinned,
            importance: keyed.importance,
            scope: keyed.scope,
            key: keyed.key,
            deduplicated: false,
            conflict: true,
            existingText: keyed.text,
          }
        }
      }

      const exact = open().findExact(text, undefined, scope, key)
      if (exact) {
        const merged = open().update(exact.id, {
          tags: mergeTagStrings(exact.tags, tags),
          pinned: exact.pinned || pinned,
          importance: Math.max(exact.importance, importance),
          key: exact.key.length === 0 ? key : exact.key,
        }) ?? exact
        return {
          id: merged.id,
          tags: merged.tags,
          pinned: merged.pinned,
          importance: merged.importance,
          scope: merged.scope,
          key: merged.key,
          deduplicated: true,
          conflict: false,
          similarity: 1,
        }
      }

      const similar = open().findSimilar(
        text,
        config.dedupSimilarityThreshold,
        1,
        undefined,
        scope,
        key,
      )[0]

      if (similar) {
        const merged = open().update(similar.record.id, {
          tags: mergeTagStrings(similar.record.tags, tags),
          pinned: similar.record.pinned || pinned,
          importance: Math.max(similar.record.importance, importance),
          key: similar.record.key.length === 0 ? key : similar.record.key,
        }) ?? similar.record
        return {
          id: merged.id,
          tags: merged.tags,
          pinned: merged.pinned,
          importance: merged.importance,
          scope: merged.scope,
          key: merged.key,
          deduplicated: true,
          conflict: false,
          similarity: similar.similarity,
        }
      }

      const record = open().write(text, tags, pinned, importance, scope, key)
      return {
        id: record.id,
        tags: record.tags,
        pinned: record.pinned,
        importance: record.importance,
        scope: record.scope,
        key: record.key,
        deduplicated: false,
        conflict: false,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_update',
    description: UPDATE_DESCRIPTION,
    parameters: {
      id: { type: 'integer', required: true, description: 'The memory id to update.' },
      text: { type: 'string', description: 'Replacement self-contained durable fact.' },
      tags: {
        type: 'array',
        description: 'Replacement labels. Omit to preserve current tags.',
        items: { type: 'string' },
      },
      pinned: { type: 'boolean', description: 'Replacement pinned state.' },
      importance: { type: 'number', description: 'Replacement importance from 1 to 5.' },
      scope: {
        type: 'string',
        description: 'Replacement scope, e.g. global, project:<name>, workspace:<name>.',
      },
      key: {
        type: 'string',
        description: 'Replacement canonical key. Pass an empty string to clear it.',
      },
      archived: {
        type: 'boolean',
        description: 'Archive without deleting, or restore an archived memory.',
      },
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
          importance: { type: 'integer' },
          scope: { type: 'string' },
          key: { type: 'string' },
          archived: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.updated ? `Updated memory #${value.id}.` : `No memory #${value.id} to update.`,
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `memory_update #${args.id}`,
      kind: 'edit',
      rawInput: args,
    }),
    async execute(args) {
      if (
        args.text === undefined
        && args.tags === undefined
        && args.pinned === undefined
        && args.importance === undefined
        && args.scope === undefined
        && args.key === undefined
        && args.archived === undefined
      ) {
        throw new Error('memory_update: provide at least one field to change')
      }

      const current = open().get(args.id)
      if (!current) return { id: args.id, updated: false }

      let text: string | undefined
      if (args.text !== undefined) {
        text = args.text.trim()
        if (text.length === 0) throw new Error('memory_update: `text` must not be blank')
        if (text.length > config.maxTextChars) {
          throw new Error(
            `memory_update: \`text\` is ${text.length} chars, over the ${config.maxTextChars} limit`,
          )
        }
      }

      const scope = args.scope !== undefined
        ? validateScope(args.scope, 'memory_update')
        : current.scope
      const replacementText = text ?? current.text
      const key = args.key !== undefined
        ? validateKey(args.key, 'memory_update')
        : current.key
      const targetArchived = args.archived ?? current.archived

      if (!targetArchived && key.length > 0) {
        const keyOwner = open().findByKey(key, scope)
        if (keyOwner && keyOwner.id !== current.id) {
          throw new Error(
            `memory_update: canonical key ${key} already belongs to memory #${keyOwner.id} in scope ${scope}`,
          )
        }
      }

      const restoring = current.archived && args.archived === false
      const identityChanged = args.key !== undefined || scope !== current.scope
      if (!targetArchived && (text !== undefined || identityChanged || restoring)) {
        const exact = open().findExact(replacementText, args.id, scope, key)
        if (exact) {
          throw new Error(
            `memory_update: replacement duplicates memory #${exact.id} in scope ${scope}`,
          )
        }
        const similar = open().findSimilar(
          replacementText,
          config.dedupSimilarityThreshold,
          1,
          args.id,
          scope,
          key,
        )[0]
        if (similar) {
          throw new Error(
            `memory_update: replacement is too similar to memory #${similar.record.id} in scope ${scope}`,
          )
        }
      }

      const patch: {
        text?: string
        tags?: string
        pinned?: boolean
        importance?: number
        scope?: string
        key?: string
        archived?: boolean
      } = {}

      if (text !== undefined) patch.text = text
      if (args.tags !== undefined) patch.tags = normalizeTags(args.tags)
      if (args.pinned !== undefined) patch.pinned = args.pinned
      if (args.importance !== undefined) {
        patch.importance = validateImportance(args.importance, 'memory_update')
      }
      if (args.scope !== undefined) patch.scope = scope
      if (args.key !== undefined) patch.key = key
      if (args.archived !== undefined) patch.archived = args.archived

      const record = open().update(args.id, patch)
      if (!record) return { id: args.id, updated: false }

      return {
        id: record.id,
        updated: true,
        text: record.text,
        tags: record.tags,
        pinned: record.pinned,
        importance: record.importance,
        scope: record.scope,
        key: record.key,
        archived: record.archived,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Keywords to look for in memory text and tags.',
      },
      limit: {
        type: 'number',
        description: `Maximum results. Defaults to ${config.searchLimitDefault}.`,
      },
      scope: {
        type: 'string',
        description: 'Optional exact scope filter. Omit to search all scopes.',
      },
      includeArchived: {
        type: 'boolean',
        description: 'Include archived memories. Defaults to false.',
      },
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
                importance: { type: 'integer', required: true },
                scope: { type: 'string', required: true },
                key: { type: 'string', required: true },
                accessCount: { type: 'integer', required: true },
                archived: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.matches.length === 0
          ? `No memories match ${JSON.stringify(args.query)}.`
          : value.matches.map(match => {
              const tags = match.tags.length > 0 ? ` [${match.tags}]` : ''
              const archived = match.archived ? ', archived' : ''
              const key = match.key.length > 0 ? `, key=${match.key}` : ''
              return `- (#${match.id}, importance=${match.importance}, scope=${match.scope}${key}${archived})${tags} ${match.text}`
            }).join('\n'),
      }],
      presentationMeta: (_args, value) => ({ count: value.matches.length }),
    },
    presentCall: args => ({
      card: 'generic',
      title: `memory_search ${args.query}`,
      kind: 'search',
    }),
    async execute(args) {
      const requested = args.limit ?? config.searchLimitDefault
      if (!Number.isInteger(requested) || requested < 1) {
        throw new Error(
          `memory_search: \`limit\` must be an integer >= 1 (got ${requested})`,
        )
      }

      const scope = args.scope === undefined
        ? '*'
        : validateScope(args.scope, 'memory_search')
      const matches = open().search(
        args.query,
        Math.min(requested, config.searchLimitMax),
        scope,
        args.includeArchived ?? false,
      )

      return {
        matches: matches.map(record => ({
          id: record.id,
          text: record.text,
          tags: record.tags,
          pinned: record.pinned,
          importance: record.importance,
          scope: record.scope,
          key: record.key,
          accessCount: record.accessCount,
          archived: record.archived,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: STATS_DESCRIPTION,
    parameters: {
      scope: {
        type: 'string',
        description: 'Optional exact scope. Omit for an all-scope summary.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          active: { type: 'integer', required: true },
          archived: { type: 'integer', required: true },
          pinned: { type: 'integer', required: true },
          keyed: { type: 'integer', required: true },
          stale: { type: 'integer', required: true },
          scopes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                scope: { type: 'string', required: true },
                active: { type: 'integer', required: true },
                archived: { type: 'integer', required: true },
              },
            },
          },
          importance: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                importance: { type: 'integer', required: true },
                active: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Memory health: ${value.active} active, ${value.archived} archived, `
          + `${value.pinned} pinned, ${value.keyed} keyed, ${value.stale} stale candidate(s).`,
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: 'memory_stats',
      kind: 'search',
      rawInput: args,
    }),
    async execute(args) {
      const scope = args.scope === undefined
        ? '*'
        : validateScope(args.scope, 'memory_stats')
      return open().stats(config.staleAfterDays, scope)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_review',
    description: REVIEW_DESCRIPTION,
    parameters: {
      limit: {
        type: 'number',
        description: `Maximum duplicate pairs and stale candidates. Defaults to ${config.searchLimitDefault}.`,
      },
      similarity: {
        type: 'number',
        description: `Duplicate threshold. Defaults to ${config.reviewSimilarityThreshold}.`,
      },
      scope: {
        type: 'string',
        description: 'Exact scope to review. Omit to review every scope independently.',
      },
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
                scope: { type: 'string', required: true },
                leftText: { type: 'string', required: true },
                rightText: { type: 'string', required: true },
              },
            },
          },
          stale: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                text: { type: 'string', required: true },
                importance: { type: 'integer', required: true },
                scope: { type: 'string', required: true },
                accessCount: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Review: ${value.pairs.length} duplicate candidate pair(s), `
          + `${value.stale.length} stale candidate(s), ${value.scanned} memories scanned.`,
      }],
      presentationMeta: (_args, value) => ({
        count: value.pairs.length + value.stale.length,
      }),
    },
    presentCall: args => ({
      card: 'generic',
      title: 'memory_review',
      kind: 'search',
      rawInput: args,
    }),
    async execute(args) {
      const requested = args.limit ?? config.searchLimitDefault
      if (!Number.isInteger(requested) || requested < 1) {
        throw new Error(
          `memory_review: \`limit\` must be an integer >= 1 (got ${requested})`,
        )
      }

      const similarity = args.similarity ?? config.reviewSimilarityThreshold
      if (!Number.isFinite(similarity) || similarity <= 0 || similarity > 1) {
        throw new Error(
          `memory_review: \`similarity\` must be > 0 and <= 1 (got ${similarity})`,
        )
      }

      const scope = args.scope === undefined
        ? '*'
        : validateScope(args.scope, 'memory_review')
      const limit = Math.min(requested, config.searchLimitMax)
      const pairs = open().review(
        similarity,
        config.reviewScanLimit,
        limit,
        scope,
      )
      const stale = open().staleCandidates(
        config.staleAfterDays,
        limit,
        scope,
      )

      return {
        scanned: Math.min(open().count(scope, false), config.reviewScanLimit),
        pairs: pairs.map(pair => ({
          leftId: pair.left.id,
          rightId: pair.right.id,
          similarity: pair.similarity,
          scope: pair.left.scope,
          leftText: pair.left.text,
          rightText: pair.right.text,
        })),
        stale: stale.map(record => ({
          id: record.id,
          text: record.text,
          importance: record.importance,
          scope: record.scope,
          accessCount: record.accessCount,
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
        properties: {
          id: { type: 'integer', required: true },
          forgotten: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.forgotten
          ? `Forgot memory #${value.id}.`
          : `No memory #${value.id} to forget.`,
      }],
    },
    async execute(args) {
      return { id: args.id, forgotten: open().forget(args.id) }
    },
  }))
}
