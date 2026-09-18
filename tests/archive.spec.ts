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
import { MemoryStore, SCHEMA_VERSION } from '../src/store.ts'

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

async function v2Database(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-v2-'))
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
      access_count INTEGER NOT NULL DEFAULT 0
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

    PRAGMA user_version = 2;
  `)

  const now = Date.now()
  db.prepare(`
    INSERT INTO memories
      (text, tags, pinned, importance, scope, created_at, updated_at, last_accessed, access_count)
    VALUES (?, ?, 0, 4, 'project:alpha', ?, ?, NULL, 0)
  `).run('v2 fact survives archive migration', 'migration', now, now)
  db.close()
  return path
}

describe('schema v3 archive migration', () => {
  it('migrates v2 rows as active memories', async () => {
    const path = await v2Database()
    const store = new MemoryStore(path)

    expect(store.schemaVersion()).toBe(SCHEMA_VERSION)
    const record = store.search('archive migration', 10)[0]
    expect(record?.archived).toBe(false)
    expect(record?.archivedAt).toBeNull()
    expect(record?.importance).toBe(4)
    expect(record?.scope).toBe('project:alpha')

    store.close()
  })
})

describe('archive lifecycle', () => {
  it('hides archived memories from normal recall and search without deleting them', () => {
    const store = new MemoryStore(':memory:')
    const memory = store.write('A durable archived fact', 'archive', false, 3, 'global')

    const archived = store.archive(memory.id)
    expect(archived?.archived).toBe(true)
    expect(archived?.archivedAt).not.toBeNull()
    expect(store.count()).toBe(1)
    expect(store.count('*', false)).toBe(0)
    expect(store.forPrompt(10)).toEqual([])
    expect(store.search('archived fact', 10)).toEqual([])

    const historical = store.search('archived fact', 10, '*', true)
    expect(historical).toHaveLength(1)
    expect(historical[0]?.archived).toBe(true)

    store.close()
  })

  it('restores an archived memory', () => {
    const store = new MemoryStore(':memory:')
    const memory = store.write('Restore me later', '', false)
    store.archive(memory.id)

    const restored = store.restore(memory.id)
    expect(restored?.archived).toBe(false)
    expect(restored?.archivedAt).toBeNull()
    expect(store.search('Restore later', 10)).toHaveLength(1)

    store.close()
  })

  it('allows a new active fact after the older copy was archived', () => {
    const store = new MemoryStore(':memory:')
    const old = store.write('Same durable fact', '', false, 3, 'project:x')
    store.archive(old.id)

    expect(store.findExact('Same durable fact', undefined, 'project:x')).toBeUndefined()
    const current = store.write('Same durable fact', '', false, 3, 'project:x')
    expect(current.id).not.toBe(old.id)
    expect(store.findExact('Same durable fact', undefined, 'project:x')?.id).toBe(current.id)

    store.close()
  })
})

describe('archive lifecycle through tools', () => {
  it('archives and can search history explicitly', async () => {
    const ctx = await harness()
    const created = await call(ctx, 'memory_write', { text: 'Historical tool fact' })

    const archived = await call(ctx, 'memory_update', {
      id: created.id,
      archived: true,
    })
    expect(archived.archived).toBe(true)

    const normal = await call(ctx, 'memory_search', { query: 'Historical tool fact' })
    expect(normal.matches).toHaveLength(0)

    const history = await call(ctx, 'memory_search', {
      query: 'Historical tool fact',
      includeArchived: true,
    })
    expect(history.matches).toHaveLength(1)
    expect(history.matches[0].archived).toBe(true)

    await ctx.fiber.dispose()
  })

  it('blocks restoration when an active duplicate now exists', async () => {
    const ctx = await harness()
    const old = await call(ctx, 'memory_write', {
      text: 'Canonical package manager is pnpm',
      scope: 'project:test',
    })
    await call(ctx, 'memory_update', { id: old.id, archived: true })

    const replacement = await call(ctx, 'memory_write', {
      text: 'Canonical package manager is pnpm',
      scope: 'project:test',
    })
    expect(replacement.id).not.toBe(old.id)

    await expect(call(ctx, 'memory_update', {
      id: old.id,
      archived: false,
    })).rejects.toThrow('duplicates memory')

    await ctx.fiber.dispose()
  })
})
