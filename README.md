# DSH-memory

Curated durable memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This fork keeps the lightweight architecture of [ben7am1n/dsh-memory](https://github.com/ben7am1n/dsh-memory): one local SQLite database with FTS5, **no embedding service, no API key, no sidecar process, and no second model**.

## Current design

The plugin now has two deterministic curation layers:

1. **Write-time curation**
   - normalized exact deduplication;
   - high-confidence lexical deduplication with token-set Jaccard similarity;
   - metadata merge for tags, pinning and importance;
   - `memory_update` for correcting stale facts instead of appending replacements.

2. **Recall-time curation**
   - importance from 1 to 5;
   - explicit access count and last-access timestamp;
   - decaying recency bonus;
   - scoped memories;
   - stale-candidate review;
   - no automatic destructive deletion.

## Tools

| Tool | Purpose |
|---|---|
| `memory_write` | Store a durable fact; suppress high-confidence duplicates inside the same scope |
| `memory_update` | Correct text/metadata/scope in place |
| `memory_search` | FTS5 retrieval across all scopes or one exact scope |
| `memory_review` | Find likely duplicate pairs and stale candidates |
| `memory_forget` | Explicitly delete an obsolete memory |

## Schema v2

Schema v2 adds:

- `importance INTEGER` — 1 through 5, default 3;
- `scope TEXT` — default `global`;
- `access_count INTEGER` — incremented by explicit `memory_search` results;
- `last_accessed INTEGER` — updated by explicit search.

Existing v1 databases migrate automatically. Text, tags, ids, timestamps and pinned state are preserved, and the FTS index is rebuilt during migration.

## Recall ranking

Pinned memories are emitted first.

For normal memories, recall uses a deterministic score:

```text
importance * 10
+ 4 * log2(access_count + 1)
+ recency_bonus
```

The recency bonus starts at 10 and halves every `decayHalfLifeDays` days.

This deliberately makes **importance dominant** while still allowing frequently retrieved and recently useful memories to rank higher.

## Scopes

Scopes prevent unrelated projects from contaminating each other.

Recommended forms:

```text
global
project:mana-ponte
project:dsh-memory
workspace:university
```

Automatic write-time deduplication only compares memories inside the same scope.

When `promptScope` is non-global, automatic recall includes:

```text
global + active scope
```

For example, with:

```yaml
promptScope: project:dsh-memory
```

the prompt can see global preferences plus DSH-memory project facts, but not memories from another project.

## Stale review

`memory_review` returns stale candidates after `staleAfterDays`.

It **never deletes them automatically**.

Pinned memories and importance-5 memories are protected from stale candidacy. This keeps destructive curation an explicit action.

## Configuration

```yaml
- id: memory
  name: dsh-memory
  config:
    path: !!js dshHomePath('memory/memory.db')

    promptRecentCount: 10
    promptMaxChars: 2000
    maxTextChars: 2000
    searchLimitDefault: 10
    searchLimitMax: 50
    promptOrder: 50

    dedupSimilarityThreshold: 0.90
    reviewSimilarityThreshold: 0.65
    reviewScanLimit: 1000

    defaultScope: global
    promptScope: global
    decayHalfLifeDays: 45
    staleAfterDays: 120
```

## Why no second model?

All curation currently uses:

- SQLite;
- FTS5;
- Unicode normalization;
- token-set Jaccard similarity;
- deterministic metadata/ranking rules.

The model already running in DSH only decides **what** to remember and when to call the memory tools. There is no second LLM or embedding model resident beside it.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

CI runs against Node 22.19 and Node 24.

## License / upstream

MIT. Based on the MIT-licensed `ben7am1n/dsh-memory` implementation.
