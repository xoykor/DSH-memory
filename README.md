# DSH-memory

Curated durable memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This fork keeps the lightweight architecture of [ben7am1n/dsh-memory](https://github.com/ben7am1n/dsh-memory): one local SQLite database with FTS5, **no embedding service, no API key, no sidecar process, and no second model**.

## Curation model

The plugin uses deterministic curation in three layers:

1. **Write-time curation**
   - Unicode/case/punctuation normalization;
   - exact deduplication;
   - high-confidence token-set Jaccard deduplication;
   - metadata merge for tags, pinning and importance;
   - deduplication is isolated by scope.

2. **Recall-time curation**
   - importance from 1 to 5;
   - explicit access count;
   - last-access timestamp;
   - decaying recency bonus;
   - global/project/workspace scopes;
   - deterministic prompt ranking.

3. **Lifecycle curation**
   - stale-memory candidates;
   - non-destructive archive/restore;
   - archived memories leave normal recall/search/dedup;
   - explicit historical search can still retrieve them;
   - permanent deletion remains a separate explicit action.

No background LLM is used for any of these operations.

## Tools

| Tool | Purpose |
|---|---|
| `memory_write` | Store a durable fact and suppress high-confidence duplicates inside the same scope |
| `memory_update` | Correct text/metadata, move scope, archive, or restore a memory |
| `memory_search` | FTS5 retrieval across all scopes or one exact scope; can optionally include archive history |
| `memory_review` | Find likely duplicate pairs and stale candidates |
| `memory_forget` | Permanently delete an obsolete memory |

## Schema v3

Schema v3 stores:

| Field | Purpose |
|---|---|
| `text` | Self-contained durable fact |
| `tags` | FTS-searchable labels |
| `pinned` | Always prioritize in visible recall |
| `importance` | 1–5 durability/relevance weight |
| `scope` | Memory isolation key |
| `created_at` | Creation timestamp |
| `updated_at` | Last content/metadata change |
| `last_accessed` | Last explicit search retrieval |
| `access_count` | Number of explicit search retrievals |
| `archived` | Removes memory from normal active use without deleting |
| `archived_at` | Archive timestamp |

Existing databases migrate automatically:

```text
v1 -> v3
v2 -> v3
```

Ids, text, tags, timestamps and pinned state are preserved. v1 data receives safe defaults for new metadata.

## Recall ranking

Pinned memories are emitted first.

Normal memories use:

```text
score =
    importance * 10
  + 4 * log2(access_count + 1)
  + recency_bonus
```

The recency bonus starts at 10 and halves every `decayHalfLifeDays`.

This makes importance dominant while letting frequently retrieved and recently useful facts move upward naturally.

Importantly, decay affects the **recency bonus** rather than deleting or permanently penalizing old knowledge.

## Importance

Recommended meaning:

```text
1 = low-value contextual fact
2 = useful but replaceable
3 = normal durable memory
4 = important durable decision/preference
5 = critical/long-lived fact
```

Importance-5 memories are protected from stale candidacy.

## Scopes

Recommended scope forms:

```text
global
project:mana-ponte
project:dsh-memory
workspace:university
```

Write-time deduplication only compares active memories inside the same scope.

When automatic recall uses a non-global scope, it sees:

```text
global + active scope
```

Example:

```yaml
promptScope: project:dsh-memory
```

This recalls global preferences and DSH-memory project facts without mixing another project's memory.

## Archive vs delete

Archiving is intentionally different from deletion.

Archive:

```text
memory_update(id, archived=true)
```

An archived memory:

- stays in SQLite;
- keeps its id and metadata;
- is excluded from normal prompt recall;
- is excluded from normal search;
- is excluded from write-time deduplication;
- can be found with `memory_search(..., includeArchived=true)`;
- can be restored with `memory_update(id, archived=false)`.

Restoration runs duplicate checks again. If a newer active replacement exists in the same scope, restoration is rejected instead of creating two active canonical copies.

Permanent deletion remains:

```text
memory_forget(id)
```

## Stale review

`memory_review` reports stale candidates after `staleAfterDays`.

It never deletes or archives them automatically.

Pinned memories and importance-5 memories are protected from stale candidacy.

A typical safe lifecycle is:

```text
memory_review
      |
      +-- duplicate candidate -> memory_update / memory_forget
      |
      +-- stale candidate ----> memory_update(archived=true)
```

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

All curation uses only:

- SQLite;
- FTS5;
- Unicode normalization;
- token-set Jaccard similarity;
- timestamps and counters;
- deterministic ranking and lifecycle rules.

The model already running in DSH decides what deserves memory and when to call the tools. Nothing else needs to stay loaded in RAM/VRAM.

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
