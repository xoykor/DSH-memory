import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Memory from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MemoryStore, SCHEMA_VERSION, normalizeMemoryKey } from '../src/store.ts'

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

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

async function v3Database(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-v3-'))
  scratch.push(dir)
  const path = join(dir, 'memory.db')
  const db = new DatabaseSync(path)

  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      importance INTEGER NOT NULL DEFAULT 3,
      scope TEXT NOT NULL DEFAULT 'global',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed INTEGER,
      access_count INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER
    );

    CREATE VIRTUAL TABLE memories_fts
      USING fts5(text, tags, content='memories', content_rowid='id');

    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts (rowid, text, tags)
        VALUES (new.id, new.text, new.tags);
    END;

    CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts (memories_fts, rowid, text, tags)
        VALUES ('delete', old.id, old.text, old.tags);
    END;

    CREATE TRIGGER memories_au AFTER UPDATE OF text, tags ON memories BEGIN
      INSERT INTO memories_fts (memories_fts, rowid, text, tags)
        VALUES ('delete', old.id, old.text, old.tags);
      INSERT INTO memories_fts (rowid, text, tags)
        VALUES (new.id, new.text, new.tags);
    END;

    PRAGMA user_version = 3;
  `)

  const now = Date.now()
  db.prepare(`
    INSERT INTO memories
      (text, tags, pinned, importance, scope, created_at, updated_at,
       last_accessed, access_count, archived, archived_at)
    VALUES (?, '', 0, 3, 'global', ?, ?, NULL, 0, 0, NULL)
  `).run('v3 fact gains an empty key', now, now)
  db.close()
  return path
}

describe('schema v4 canonical key migration', () => {
  it('migrates v3 rows with an empty canonical key', async () => {
    const path = await v3Database()
    const store = new MemoryStore(path)

    expect(store.schemaVersion()).toBe(SCHEMA_VERSION)
    const record = store.search('gains empty key', 10)[0]
    expect(record?.key).toBe('')

    store.close()
  })
})

describe('canonical key normalization and storage', () => {
  it('normalizes keys predictably', () => {
    expect(normalizeMemoryKey(' Environment Shell ')).toBe('environment-shell')
    expect(normalizeMemoryKey('project.runtime:node')).toBe('project.runtime:node')
  })

  it('enforces one active key per scope', () => {
    const store = new MemoryStore(':memory:')
    store.write('fish is the shell', '', false, 3, 'global', 'environment.shell')

    expect(() => {
      store.write('bash is the shell', '', false, 3, 'global', 'environment.shell')
    }).toThrow()

    // The same key is valid in another scope.
    expect(() => {
      store.write('bash in this project', '', false, 3, 'project:test', 'environment.shell')
    }).not.toThrow()

    store.close()
  })

  it('releases a key while its previous memory is archived', () => {
    const store = new MemoryStore(':memory:')
    const old = store.write('old runtime', '', false, 3, 'project:x', 'project.runtime')
    store.archive(old.id)

    const current = store.write('new runtime', '', false, 3, 'project:x', 'project.runtime')
    expect(current.key).toBe('project.runtime')
    expect(current.id).not.toBe(old.id)

    store.close()
  })
})

describe('canonical keys through model-facing tools', () => {
  it('returns a conflict instead of overwriting a different fact with the same key', async () => {
    const ctx = await harness()
    const first = await call(ctx, 'memory_write', {
      text: 'The project runtime is Node 22',
      scope: 'project:test',
      key: 'project.runtime',
    })

    const conflict = await call(ctx, 'memory_write', {
      text: 'The project runtime is Node 24',
      scope: 'project:test',
      key: 'project.runtime',
    })

    expect(conflict.id).toBe(first.id)
    expect(conflict.conflict).toBe(true)
    expect(conflict.deduplicated).toBe(false)
    expect(conflict.existingText).toBe('The project runtime is Node 22')

    const old = await call(ctx, 'memory_search', {
      query: 'Node 22',
      scope: 'project:test',
    })
    const newer = await call(ctx, 'memory_search', {
      query: 'Node 24',
      scope: 'project:test',
    })
    expect(old.matches).toHaveLength(1)
    expect(newer.matches).toHaveLength(0)

    await ctx.fiber.dispose()
  })

  it('deduplicates equivalent text using the same canonical key', async () => {
    const ctx = await harness()
    const first = await call(ctx, 'memory_write', {
      text: 'User shell is fish',
      key: 'environment.shell',
      tags: ['shell'],
    })
    const second = await call(ctx, 'memory_write', {
      text: 'user shell is FISH!',
      key: 'environment.shell',
      tags: ['preference'],
      importance: 4,
    })

    expect(second.id).toBe(first.id)
    expect(second.conflict).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(second.key).toBe('environment.shell')
    expect(second.importance).toBe(4)

    await ctx.fiber.dispose()
  })

  it('allows explicit update of a keyed fact', async () => {
    const ctx = await harness()
    const created = await call(ctx, 'memory_write', {
      text: 'The project runtime is Node 22',
      scope: 'project:test',
      key: 'project.runtime',
    })

    const updated = await call(ctx, 'memory_update', {
      id: created.id,
      text: 'The project runtime is Node 24',
    })
    expect(updated.updated).toBe(true)
    expect(updated.key).toBe('project.runtime')

    const found = await call(ctx, 'memory_search', {
      query: 'Node 24',
      scope: 'project:test',
    })
    expect(found.matches[0]?.key).toBe('project.runtime')

    await ctx.fiber.dispose()
  })

  it('keeps distinct canonical identities separate even when text is identical', async () => {
    const ctx = await harness({ dedupSimilarityThreshold: 0.9 })
    const runtime = await call(ctx, 'memory_write', {
      text: 'Value is enabled',
      scope: 'project:test',
      key: 'project.runtime-enabled',
    })
    const feature = await call(ctx, 'memory_write', {
      text: 'Value is enabled',
      scope: 'project:test',
      key: 'project.feature-enabled',
    })

    expect(feature.id).not.toBe(runtime.id)
    expect(feature.deduplicated).toBe(false)
    expect(feature.conflict).toBe(false)
    expect(feature.key).toBe('project.feature-enabled')

    await ctx.fiber.dispose()
  })

  it('can adopt an unkeyed duplicate into a canonical key', async () => {
    const ctx = await harness()
    const unkeyed = await call(ctx, 'memory_write', {
      text: 'Project package manager is pnpm',
      scope: 'project:test',
    })
    const keyed = await call(ctx, 'memory_write', {
      text: 'Project package manager is pnpm',
      scope: 'project:test',
      key: 'project.package-manager',
    })

    expect(keyed.id).toBe(unkeyed.id)
    expect(keyed.deduplicated).toBe(true)
    expect(keyed.key).toBe('project.package-manager')

    await ctx.fiber.dispose()
  })

  it('allows archived history to be edited even when an active replacement matches it', async () => {
    const ctx = await harness()
    const old = await call(ctx, 'memory_write', {
      text: 'Runtime used to be Node 22',
      scope: 'project:test',
      key: 'project.runtime',
    })
    await call(ctx, 'memory_update', { id: old.id, archived: true })

    await call(ctx, 'memory_write', {
      text: 'Runtime is Node 24',
      scope: 'project:test',
      key: 'project.runtime',
    })

    const editedArchive = await call(ctx, 'memory_update', {
      id: old.id,
      text: 'Runtime is Node 24',
    })
    expect(editedArchive.updated).toBe(true)
    expect(editedArchive.archived).toBe(true)

    await ctx.fiber.dispose()
  })

  it('rejects assigning an active key already owned by another memory', async () => {
    const ctx = await harness({ dedupSimilarityThreshold: 1 })
    const one = await call(ctx, 'memory_write', {
      text: 'First canonical fact',
      key: 'fact.one',
    })
    const two = await call(ctx, 'memory_write', {
      text: 'Second canonical fact',
      key: 'fact.two',
    })

    await expect(call(ctx, 'memory_update', {
      id: two.id,
      key: 'fact.one',
    })).rejects.toThrow('already belongs to memory')

    const unchanged = await call(ctx, 'memory_search', { query: 'Second canonical fact' })
    expect(unchanged.matches[0]?.key).toBe('fact.two')
    expect(one.id).not.toBe(two.id)

    await ctx.fiber.dispose()
  })
})
