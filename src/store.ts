/**
 * SQLite-backed memory store: a plain `memories` table with an external-content
 * FTS5 index kept in sync by triggers. Owned entirely by this package — the
 * harness's own SQLite backends index sessions, not durable user facts.
 * @module dsh-memory/store
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Monotonic on-disk schema version; a mismatch rebuilds the derived index. */
export const SCHEMA_VERSION = 1

/** One stored memory as tools and the prompt section see it. */
export interface MemoryRecord {
  id: number
  text: string
  /** Normalized, space-joined tag list; empty string when untagged. */
  tags: string
  /** Pinned memories always render in the prompt section, ahead of recent ones. */
  pinned: boolean
  createdAt: number
  updatedAt: number
}

/** A search hit: the record plus its FTS rank (lower is a better match). */
export interface MemoryMatch extends MemoryRecord {
  rank: number
}

/** A deterministic lexical-similarity candidate. */
export interface MemorySimilarity {
  record: MemoryRecord
  similarity: number
}

/** A likely-duplicate pair returned by a review pass. */
export interface MemoryReviewPair {
  left: MemoryRecord
  right: MemoryRecord
  similarity: number
}

/** Row shape returned by the statements below, before field-name and boolean normalization. */
interface MemoryRow {
  id: number
  text: string
  tags: string
  pinned: number
  created_at: number
  updated_at: number
  rank?: number
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memories_recent ON memories (updated_at DESC, id DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(text, tags, content='memories', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END;
`

/**
 * Normalize a tag list to the lowercase, deduplicated, space-joined form the
 * FTS index stores, so `Foo`, `foo`, and a repeated `foo` all match `foo`.
 * @param tags - tags as supplied by the model or config.
 * @returns the normalized space-joined list, empty when nothing survives.
 */
export function normalizeTags(tags: readonly string[]): string {
  const seen = new Set<string>()
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase().replaceAll(/\s+/g, '-')
    if (normalized.length > 0) seen.add(normalized)
  }
  return [...seen].join(' ')
}

/** Normalize text for deterministic duplicate detection. */
export function normalizeMemoryText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Token-set Jaccard similarity in the [0, 1] interval. */
export function lexicalSimilarity(left: string, right: string): number {
  const a = new Set(normalizeMemoryText(left).split(' ').filter(Boolean))
  const b = new Set(normalizeMemoryText(right).split(' ').filter(Boolean))
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Compile a free-text query into an FTS5 MATCH expression. Every token is
 * quoted, so FTS5 operators a model happens to type (`OR`, `*`, `-`, `"`) are
 * matched literally instead of changing the query's meaning or raising a
 * syntax error mid-tool-call.
 * @param query - the raw query text.
 * @returns the MATCH expression, or undefined when the query has no usable token.
 */
export function compileMatch(query: string): string | undefined {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(token => token.length > 0)
    .map(token => `"${token}"`)
  return tokens.length > 0 ? tokens.join(' ') : undefined
}

/** Map one row to the record shape, converting SQLite's integer boolean. */
function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    text: row.text,
    tags: row.tags,
    pinned: row.pinned !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * The durable memory store. One instance owns one SQLite connection; `close()`
 * is idempotent and runs from the plugin's disposer.
 */
export class MemoryStore {
  readonly #db: DatabaseSync
  #closed = false

  /**
   * Open (creating if absent) the store at `path`, applying the schema.
   * @param path - database file path, or `:memory:` for an ephemeral store.
   */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#db.exec(SCHEMA)
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  /**
   * Store one memory.
   * @param text - the fact to remember.
   * @param tags - normalized tag list.
   * @param pinned - whether it always renders in the prompt section.
   * @returns the new record.
   */
  write(text: string, tags: string, pinned: boolean): MemoryRecord {
    const now = Date.now()
    const statement = this.#db.prepare(
      'INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
    return toRecord(statement.get(text, tags, pinned ? 1 : 0, now, now) as unknown as MemoryRow)
  }

  /** Fetch one memory by id. */
  get(id: number): MemoryRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow | undefined
    return row ? toRecord(row) : undefined
  }

  /** Find an exact duplicate after deterministic normalization. */
  findExact(text: string, excludeId?: number): MemoryRecord | undefined {
    const wanted = normalizeMemoryText(text)
    if (wanted.length === 0) return undefined
    const rows = this.#db.prepare('SELECT * FROM memories').all() as unknown as MemoryRow[]
    for (const row of rows) {
      if (excludeId !== undefined && row.id === excludeId) continue
      if (normalizeMemoryText(row.text) === wanted) return toRecord(row)
    }
    return undefined
  }

  /** Find lexically similar memories using local Jaccard similarity. */
  findSimilar(text: string, threshold: number, limit: number, excludeId?: number): MemorySimilarity[] {
    const rows = this.#db.prepare('SELECT * FROM memories').all() as unknown as MemoryRow[]
    return rows
      .filter(row => excludeId === undefined || row.id !== excludeId)
      .map(row => {
        const record = toRecord(row)
        return { record, similarity: lexicalSimilarity(text, record.text) }
      })
      .filter(candidate => candidate.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity || b.record.updatedAt - a.record.updatedAt || b.record.id - a.record.id)
      .slice(0, limit)
  }

  /** Update one memory in place so changed facts do not accumulate stale copies. */
  update(id: number, patch: { text?: string; tags?: string; pinned?: boolean }): MemoryRecord | undefined {
    const current = this.get(id)
    if (!current) return undefined
    const text = patch.text ?? current.text
    const tags = patch.tags ?? current.tags
    const pinned = patch.pinned ?? current.pinned
    const now = Date.now()
    const row = this.#db.prepare(
      'UPDATE memories SET text = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ? RETURNING *',
    ).get(text, tags, pinned ? 1 : 0, now, id) as unknown as MemoryRow | undefined
    return row ? toRecord(row) : undefined
  }

  /** Read-only bounded review for likely duplicate pairs. */
  review(threshold: number, scanLimit: number, resultLimit: number): MemoryReviewPair[] {
    const rows = this.#db.prepare(
      'SELECT * FROM memories ORDER BY updated_at DESC, id DESC LIMIT ?',
    ).all(scanLimit) as unknown as MemoryRow[]
    const records = rows.map(toRecord)
    const pairs: MemoryReviewPair[] = []
    for (let left = 0; left < records.length; left++) {
      const a = records[left]
      if (!a) continue
      for (let right = left + 1; right < records.length; right++) {
        const b = records[right]
        if (!b) continue
        const similarity = lexicalSimilarity(a.text, b.text)
        if (similarity >= threshold) pairs.push({ left: a, right: b, similarity })
      }
    }
    return pairs
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, resultLimit)
  }

  /**
   * Full-text search over memory text and tags, best match first.
   * @param query - free-text query; FTS operators in it are matched literally.
   * @param limit - maximum hits to return.
   * @returns the ranked matches, empty when the query has no usable token.
   */
  search(query: string, limit: number): MemoryMatch[] {
    const match = compileMatch(query)
    if (match === undefined) return []
    const rows = this.#db.prepare(`
      SELECT m.*, memories_fts.rank AS rank
      FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?
    `).all(match, limit) as unknown as MemoryRow[]
    return rows.map(row => ({ ...toRecord(row), rank: row.rank ?? 0 }))
  }

  /**
   * The memories the prompt section renders: pinned first, then most recently
   * updated, with no record repeated.
   * @param recentCount - how many unpinned recent memories to include.
   * @returns pinned records followed by recent ones.
   */
  forPrompt(recentCount: number): MemoryRecord[] {
    // `id DESC` breaks the tie: several memories written in the same
    // millisecond share an `updated_at`, and without it their relative order
    // is whatever the planner returns rather than newest-first.
    const pinned = this.#db.prepare(
      'SELECT * FROM memories WHERE pinned = 1 ORDER BY updated_at DESC, id DESC').all() as unknown as MemoryRow[]
    const recent = this.#db.prepare(
      'SELECT * FROM memories WHERE pinned = 0 ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(recentCount) as unknown as MemoryRow[]
    return [...pinned, ...recent].map(toRecord)
  }

  /**
   * Delete one memory.
   * @param id - the record id.
   * @returns whether a record was deleted.
   */
  forget(id: number): boolean {
    return this.#db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0
  }

  /**
   * Total stored memories.
   * @returns the row count.
   */
  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM memories').get() as unknown as { n: number }
    return row.n
  }

  /** Close the connection; idempotent, so plugin disposal and tests may both call it. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}
