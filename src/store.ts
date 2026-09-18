/**
 * SQLite-backed curated memory store for DeepSeek Harness.
 *
 * Schema v2 adds deterministic ranking/curation metadata while keeping the
 * original FTS5 design: no embeddings, API key, sidecar process or second LLM.
 * @module dsh-memory/store
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 4
const DAY_MS = 86_400_000

export interface MemoryRecord {
  id: number
  text: string
  tags: string
  pinned: boolean
  /** 1 = low-value/contextual, 3 = normal, 5 = durable/critical. */
  importance: number
  /** global, project:<id>, workspace:<id>, or another explicit local scope. */
  scope: string
  /** Optional canonical identity, unique among active memories inside a scope. */
  key: string
  createdAt: number
  updatedAt: number
  lastAccessed: number | null
  accessCount: number
  /** Archived memories stay durable but leave normal recall/search/dedup. */
  archived: boolean
  archivedAt: number | null
}

export interface MemoryMatch extends MemoryRecord {
  /** FTS5 rank; lower is a better lexical match. */
  rank: number
}

export interface MemorySimilarity {
  record: MemoryRecord
  similarity: number
}

export interface MemoryReviewPair {
  left: MemoryRecord
  right: MemoryRecord
  similarity: number
}

interface MemoryRow {
  id: number
  text: string
  tags: string
  pinned: number
  importance: number
  scope: string
  memory_key: string
  created_at: number
  updated_at: number
  last_accessed: number | null
  access_count: number
  archived: number
  archived_at: number | null
  rank?: number
}

const CREATE_LATEST = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    importance INTEGER NOT NULL DEFAULT 3,
    scope TEXT NOT NULL DEFAULT 'global',
    memory_key TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_accessed INTEGER,
    access_count INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER
  );
`

const DERIVED_SCHEMA = `
  CREATE INDEX IF NOT EXISTS memories_recent
    ON memories (updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS memories_active_scope_priority
    ON memories (archived, scope, pinned DESC, importance DESC, updated_at DESC);
  CREATE INDEX IF NOT EXISTS memories_archive
    ON memories (archived, archived_at DESC);
  CREATE INDEX IF NOT EXISTS memories_access
    ON memories (last_accessed DESC, access_count DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS memories_active_key
    ON memories (scope, memory_key)
    WHERE archived = 0 AND memory_key <> '';

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(text, tags, content='memories', content_rowid='id');

  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, text, tags)
      VALUES (new.id, new.text, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags)
      VALUES ('delete', old.id, old.text, old.tags);
  END;
`

const UPDATE_TRIGGER = `
  DROP TRIGGER IF EXISTS memories_au;
  CREATE TRIGGER memories_au AFTER UPDATE OF text, tags ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags)
      VALUES ('delete', old.id, old.text, old.tags);
    INSERT INTO memories_fts (rowid, text, tags)
      VALUES (new.id, new.text, new.tags);
  END;
`

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

/**
 * Scope normalization is intentionally predictable and filesystem-independent.
 * Names remain human-readable while whitespace/case differences collapse.
 */
export function normalizeScope(scope: string): string {
  return scope
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
}

/** Normalize an optional canonical memory key. Empty means "no key". */
export function normalizeMemoryKey(key: string): string {
  return key
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Token-set Jaccard similarity in [0, 1]. */
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
 * Deterministic recall score.
 *
 * Importance is deliberately dominant. Explicit retrieval adds a small,
 * logarithmic bonus. Recency contributes a decaying bonus with a configurable
 * half-life instead of permanently punishing old but still-important facts.
 */
export function memoryPriority(
  record: MemoryRecord,
  decayHalfLifeDays: number,
  now = Date.now(),
): number {
  const lastUseful = Math.max(record.updatedAt, record.lastAccessed ?? 0)
  const ageDays = Math.max(0, now - lastUseful) / DAY_MS
  const recency = 10 * Math.pow(0.5, ageDays / decayHalfLifeDays)
  const usage = 4 * Math.log2(record.accessCount + 1)
  return record.importance * 10 + usage + recency
}

/**
 * Compile free text to literal FTS5 tokens. FTS operators typed by the model
 * never become executable query syntax.
 */
export function compileMatch(query: string): string | undefined {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(token => token.length > 0)
    .map(token => `"${token}"`)
  return tokens.length > 0 ? tokens.join(' ') : undefined
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    text: row.text,
    tags: row.tags,
    pinned: row.pinned !== 0,
    importance: row.importance,
    scope: row.scope,
    key: row.memory_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    archived: row.archived !== 0,
    archivedAt: row.archived_at,
  }
}

function visibleScopes(scope: string): string[] {
  return scope === 'global' ? ['global'] : ['global', scope]
}

export class MemoryStore {
  readonly #db: DatabaseSync
  #closed = false

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#migrate()
  }

  #migrate(): void {
    const versionRow = this.#db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }
    let version = versionRow.user_version

    // Defensive handling for an unversioned database that already has a table.
    if (version === 0) {
      const exists = this.#db.prepare(
        "SELECT 1 AS yes FROM sqlite_master WHERE type = 'table' AND name = 'memories'",
      ).get() as unknown as { yes: number } | undefined
      if (exists) {
        const columns = this.#db.prepare('PRAGMA table_info(memories)').all() as unknown as { name: string }[]
        if (columns.some(column => column.name === 'memory_key')) version = 4
        else if (columns.some(column => column.name === 'archived')) version = 3
        else if (columns.some(column => column.name === 'importance')) version = 2
        else version = 1
      }
    }

    if (version > SCHEMA_VERSION) {
      throw new Error(
        `memory: database schema v${version} is newer than supported v${SCHEMA_VERSION}`,
      )
    }

    if (version === 0) {
      this.#db.exec('BEGIN')
      try {
        this.#db.exec(CREATE_LATEST)
        this.#db.exec(DERIVED_SCHEMA)
        this.#db.exec(UPDATE_TRIGGER)
        // Rebuild makes migration robust even if the old derived FTS index was
        // missing or stale; v1 databases normally already have it populated.
        this.#db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
        this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
      return
    }

    if (version === 1) {
      this.#db.exec('BEGIN')
      try {
        this.#db.exec(`
          ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 3;
          ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
          ALTER TABLE memories ADD COLUMN memory_key TEXT NOT NULL DEFAULT '';
          ALTER TABLE memories ADD COLUMN last_accessed INTEGER;
          ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE memories ADD COLUMN archived_at INTEGER;
        `)
        this.#db.exec(DERIVED_SCHEMA)
        this.#db.exec(UPDATE_TRIGGER)
        this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
      return
    }

    if (version === 2) {
      this.#db.exec('BEGIN')
      try {
        this.#db.exec(`
          ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE memories ADD COLUMN archived_at INTEGER;
          ALTER TABLE memories ADD COLUMN memory_key TEXT NOT NULL DEFAULT '';
        `)
        this.#db.exec(DERIVED_SCHEMA)
        this.#db.exec(UPDATE_TRIGGER)
        this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
      return
    }

    if (version === 3) {
      this.#db.exec('BEGIN')
      try {
        this.#db.exec(`
          ALTER TABLE memories ADD COLUMN memory_key TEXT NOT NULL DEFAULT '';
        `)
        this.#db.exec(DERIVED_SCHEMA)
        this.#db.exec(UPDATE_TRIGGER)
        this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
      return
    }

    // Current databases may be reopened by builds that add derived indexes/triggers.
    this.#db.exec(CREATE_LATEST)
    this.#db.exec(DERIVED_SCHEMA)
    this.#db.exec(UPDATE_TRIGGER)
  }

  schemaVersion(): number {
    const row = this.#db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }
    return row.user_version
  }

  write(
    text: string,
    tags: string,
    pinned: boolean,
    importance = 3,
    scope = 'global',
    key = '',
  ): MemoryRecord {
    const now = Date.now()
    const statement = this.#db.prepare(`
      INSERT INTO memories
        (text, tags, pinned, importance, scope, memory_key, created_at, updated_at,
         last_accessed, access_count, archived, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, NULL)
      RETURNING *
    `)
    return toRecord(statement.get(
      text,
      tags,
      pinned ? 1 : 0,
      importance,
      scope,
      key,
      now,
      now,
    ) as unknown as MemoryRow)
  }

  get(id: number): MemoryRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as unknown as MemoryRow | undefined
    return row ? toRecord(row) : undefined
  }

  findByKey(key: string, scope = 'global', includeArchived = false): MemoryRecord | undefined {
    if (key.length === 0) return undefined
    const archived = includeArchived ? '' : ' AND archived = 0'
    const row = this.#db.prepare(
      `SELECT * FROM memories WHERE scope = ? AND memory_key = ?${archived} ORDER BY archived ASC, updated_at DESC LIMIT 1`,
    ).get(scope, key) as unknown as MemoryRow | undefined
    return row ? toRecord(row) : undefined
  }

  findExact(text: string, excludeId?: number, scope = 'global'): MemoryRecord | undefined {
    const wanted = normalizeMemoryText(text)
    if (wanted.length === 0) return undefined

    const rows = this.#db.prepare('SELECT * FROM memories WHERE scope = ? AND archived = 0')
      .all(scope) as unknown as MemoryRow[]
    for (const row of rows) {
      if (excludeId !== undefined && row.id === excludeId) continue
      if (normalizeMemoryText(row.text) === wanted) return toRecord(row)
    }
    return undefined
  }

  findSimilar(
    text: string,
    threshold: number,
    limit: number,
    excludeId?: number,
    scope = 'global',
  ): MemorySimilarity[] {
    const rows = this.#db.prepare('SELECT * FROM memories WHERE scope = ? AND archived = 0')
      .all(scope) as unknown as MemoryRow[]

    return rows
      .filter(row => excludeId === undefined || row.id !== excludeId)
      .map(row => {
        const record = toRecord(row)
        return { record, similarity: lexicalSimilarity(text, record.text) }
      })
      .filter(candidate => candidate.similarity >= threshold)
      .sort((a, b) =>
        b.similarity - a.similarity
        || b.record.importance - a.record.importance
        || b.record.updatedAt - a.record.updatedAt
        || b.record.id - a.record.id)
      .slice(0, limit)
  }

  update(
    id: number,
    patch: {
      text?: string
      tags?: string
      pinned?: boolean
      importance?: number
      scope?: string
      key?: string
      archived?: boolean
    },
  ): MemoryRecord | undefined {
    const current = this.get(id)
    if (!current) return undefined

    const now = Date.now()
    const archived = patch.archived ?? current.archived
    const archivedAt = archived
      ? (current.archived ? current.archivedAt ?? now : now)
      : null
    const row = this.#db.prepare(`
      UPDATE memories
      SET text = ?, tags = ?, pinned = ?, importance = ?, scope = ?, memory_key = ?,
          archived = ?, archived_at = ?, updated_at = ?
      WHERE id = ?
      RETURNING *
    `).get(
      patch.text ?? current.text,
      patch.tags ?? current.tags,
      (patch.pinned ?? current.pinned) ? 1 : 0,
      patch.importance ?? current.importance,
      patch.scope ?? current.scope,
      patch.key ?? current.key,
      archived ? 1 : 0,
      archivedAt,
      now,
      id,
    ) as unknown as MemoryRow | undefined

    return row ? toRecord(row) : undefined
  }

  review(
    threshold: number,
    scanLimit: number,
    resultLimit: number,
    scope = '*',
  ): MemoryReviewPair[] {
    const rows = scope === '*'
      ? this.#db.prepare(
          'SELECT * FROM memories WHERE archived = 0 ORDER BY updated_at DESC, id DESC LIMIT ?',
        ).all(scanLimit) as unknown as MemoryRow[]
      : this.#db.prepare(
          'SELECT * FROM memories WHERE scope = ? AND archived = 0 ORDER BY updated_at DESC, id DESC LIMIT ?',
        ).all(scope, scanLimit) as unknown as MemoryRow[]

    const records = rows.map(toRecord)
    const pairs: MemoryReviewPair[] = []

    for (let left = 0; left < records.length; left++) {
      const a = records[left]
      if (!a) continue
      for (let right = left + 1; right < records.length; right++) {
        const b = records[right]
        if (!b || a.scope !== b.scope) continue
        const similarity = lexicalSimilarity(a.text, b.text)
        if (similarity >= threshold) pairs.push({ left: a, right: b, similarity })
      }
    }

    return pairs
      .sort((a, b) =>
        b.similarity - a.similarity
        || b.left.importance - a.left.importance)
      .slice(0, resultLimit)
  }

  search(query: string, limit: number, scope = '*', includeArchived = false): MemoryMatch[] {
    const match = compileMatch(query)
    if (match === undefined) return []

    const archivedClause = includeArchived ? '' : ' AND m.archived = 0'
    const rows = scope === '*'
      ? this.#db.prepare(`
          SELECT m.*, memories_fts.rank AS rank
          FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
          WHERE memories_fts MATCH ?${archivedClause}
          ORDER BY rank
          LIMIT ?
        `).all(match, limit) as unknown as MemoryRow[]
      : this.#db.prepare(`
          SELECT m.*, memories_fts.rank AS rank
          FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
          WHERE memories_fts MATCH ? AND m.scope = ?${archivedClause}
          ORDER BY rank
          LIMIT ?
        `).all(match, scope, limit) as unknown as MemoryRow[]

    const now = Date.now()
    const touch = this.#db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1, last_accessed = ?
      WHERE id = ?
    `)
    for (const row of rows) touch.run(now, row.id)

    return rows.map(row => ({
      ...toRecord({
        ...row,
        last_accessed: now,
        access_count: row.access_count + 1,
      }),
      rank: row.rank ?? 0,
    }))
  }

  /**
   * Pinned memories are always first. Non-pinned memories are ranked by
   * importance + explicit retrieval frequency + decaying recency.
   *
   * A non-global prompt scope sees both global memories and its own scope.
   */
  forPrompt(
    recentCount: number,
    scope = 'global',
    decayHalfLifeDays = 45,
    now = Date.now(),
  ): MemoryRecord[] {
    const scopes = visibleScopes(scope)
    const placeholders = scopes.map(() => '?').join(', ')
    const rows = this.#db.prepare(
      `SELECT * FROM memories WHERE archived = 0 AND scope IN (${placeholders})`,
    ).all(...scopes) as unknown as MemoryRow[]
    const records = rows.map(toRecord)

    const pinned = records
      .filter(record => record.pinned)
      .sort((a, b) =>
        b.importance - a.importance
        || b.updatedAt - a.updatedAt
        || b.id - a.id)

    const ranked = records
      .filter(record => !record.pinned)
      .sort((a, b) =>
        memoryPriority(b, decayHalfLifeDays, now)
        - memoryPriority(a, decayHalfLifeDays, now)
        || b.updatedAt - a.updatedAt
        || b.id - a.id)
      .slice(0, recentCount)

    return [...pinned, ...ranked]
  }

  /**
   * Read-only stale-memory candidates. Importance 5 and pinned memories are
   * protected; this method never deletes anything automatically.
   */
  staleCandidates(
    staleAfterDays: number,
    limit: number,
    scope = '*',
    now = Date.now(),
  ): MemoryRecord[] {
    const cutoff = now - staleAfterDays * DAY_MS
    const base = `
      archived = 0
      AND pinned = 0
      AND importance < 5
      AND MAX(updated_at, COALESCE(last_accessed, 0)) < ?
    `

    const rows = scope === '*'
      ? this.#db.prepare(`
          SELECT * FROM memories
          WHERE ${base}
          ORDER BY importance ASC,
                   MAX(updated_at, COALESCE(last_accessed, 0)) ASC,
                   access_count ASC
          LIMIT ?
        `).all(cutoff, limit) as unknown as MemoryRow[]
      : this.#db.prepare(`
          SELECT * FROM memories
          WHERE scope = ? AND ${base}
          ORDER BY importance ASC,
                   MAX(updated_at, COALESCE(last_accessed, 0)) ASC,
                   access_count ASC
          LIMIT ?
        `).all(scope, cutoff, limit) as unknown as MemoryRow[]

    return rows.map(toRecord)
  }

  forget(id: number): boolean {
    return this.#db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0
  }

  archive(id: number): MemoryRecord | undefined {
    return this.update(id, { archived: true })
  }

  restore(id: number): MemoryRecord | undefined {
    return this.update(id, { archived: false })
  }

  count(scope = '*', includeArchived = true): number {
    const archived = includeArchived ? '' : ' AND archived = 0'
    const row = scope === '*'
      ? this.#db.prepare(
          `SELECT COUNT(*) AS n FROM memories WHERE 1 = 1${archived}`,
        ).get() as unknown as { n: number }
      : this.#db.prepare(
          `SELECT COUNT(*) AS n FROM memories WHERE scope = ?${archived}`,
        ).get(scope) as unknown as { n: number }
    return row.n
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}
