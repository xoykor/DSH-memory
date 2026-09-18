import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, SCHEMA_VERSION, memoryPriority } from '../src/store.ts'

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function v1Database(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-v1-'))
  scratch.push(dir)
  const path = join(dir, 'memory.db')
  const db = new DatabaseSync(path)

  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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

    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts (memories_fts, rowid, text, tags)
        VALUES ('delete', old.id, old.text, old.tags);
      INSERT INTO memories_fts (rowid, text, tags)
        VALUES (new.id, new.text, new.tags);
    END;

    PRAGMA user_version = 1;
  `)

  const old = Date.now() - 10 * 86_400_000
  db.prepare(
    'INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('Migrated durable fact about pnpm', 'build', 0, old, old)
  db.close()
  return path
}

describe('schema v2 migration', () => {
  it('migrates a real v1 database without losing memory or FTS search', async () => {
    const path = await v1Database()
    const store = new MemoryStore(path)

    expect(store.schemaVersion()).toBe(SCHEMA_VERSION)
    expect(store.count()).toBe(1)

    const migrated = store.search('pnpm', 10)[0]
    expect(migrated?.text).toBe('Migrated durable fact about pnpm')
    expect(migrated?.importance).toBe(3)
    expect(migrated?.scope).toBe('global')
    expect(migrated?.accessCount).toBe(1)
    expect(migrated?.lastAccessed).not.toBeNull()

    store.close()
  })
})

describe('recall ranking', () => {
  it('keeps importance dominant over recency', () => {
    const store = new MemoryStore(':memory:')
    const normal = store.write('normal memory', '', false, 3)
    const critical = store.write('critical memory', '', false, 5)

    expect(memoryPriority(critical, 45)).toBeGreaterThan(memoryPriority(normal, 45))
    expect(store.forPrompt(2).map(record => record.text)).toEqual([
      'critical memory',
      'normal memory',
    ])
    store.close()
  })

  it('increments access statistics only when explicitly searched', () => {
    const store = new MemoryStore(':memory:')
    const record = store.write('The preferred package manager is pnpm', '', false, 3)

    expect(store.get(record.id)?.accessCount).toBe(0)
    store.search('pnpm', 10)
    store.search('pnpm', 10)
    store.search('pnpm', 10)

    const touched = store.get(record.id)
    expect(touched?.accessCount).toBe(3)
    expect(touched?.lastAccessed).not.toBeNull()
    store.close()
  })
})

describe('scopes', () => {
  it('does not deduplicate the same text across independent scopes', () => {
    const store = new MemoryStore(':memory:')
    const global = store.write('Use fish shell', '', false, 3, 'global')
    const project = store.write('Use fish shell', '', false, 3, 'project:alpha')

    expect(global.id).not.toBe(project.id)
    expect(store.findExact('Use fish shell', undefined, 'global')?.id).toBe(global.id)
    expect(store.findExact('Use fish shell', undefined, 'project:alpha')?.id).toBe(project.id)
    store.close()
  })

  it('shows global + active project scope, but not unrelated projects', () => {
    const store = new MemoryStore(':memory:')
    store.write('global preference', '', false, 3, 'global')
    store.write('alpha decision', '', false, 3, 'project:alpha')
    store.write('beta decision', '', false, 3, 'project:beta')

    expect(store.forPrompt(10, 'project:alpha').map(record => record.text)).toEqual(
      expect.arrayContaining(['global preference', 'alpha decision']),
    )
    expect(store.forPrompt(10, 'project:alpha').map(record => record.text))
      .not.toContain('beta decision')
    expect(store.forPrompt(10, 'global').map(record => record.text))
      .toEqual(['global preference'])

    store.close()
  })
})

describe('stale review', () => {
  it('returns old low/normal importance memories but protects pinned and importance 5', () => {
    const store = new MemoryStore(':memory:')
    const candidate = store.write('ordinary old fact', '', false, 2)
    store.write('critical old fact', '', false, 5)
    store.write('pinned old fact', '', true, 1)

    const future = Date.now() + 200 * 86_400_000
    const stale = store.staleCandidates(120, 20, '*', future)

    expect(stale.map(record => record.id)).toContain(candidate.id)
    expect(stale.map(record => record.text)).not.toContain('critical old fact')
    expect(stale.map(record => record.text)).not.toContain('pinned old fact')
    store.close()
  })
})
