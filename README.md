# DSH-memory

Curated durable memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This fork keeps the lightweight architecture of [ben7am1n/dsh-memory](https://github.com/ben7am1n/dsh-memory): one local SQLite database with FTS5, **no embedding service, no API key, no sidecar process, and no second model**.

## Curation model

Curation is deterministic and local:

1. **Write-time**
   - normalized exact deduplication;
   - high-confidence token-set Jaccard deduplication;
   - metadata merge;
   - optional canonical keys;
   - scope isolation.

2. **Recall-time**
   - importance 1–5;
   - explicit access count;
   - last-access timestamp;
   - decaying recency bonus;
   - global/project/workspace scopes;
   - deterministic prompt ranking.

3. **Lifecycle**
   - stale candidates;
   - archive/restore without data loss;
   - archived memories leave active recall/search/dedup;
   - permanent deletion remains explicit.

4. **Conflict control**
   - an optional canonical key can identify one durable fact;
   - active keys are unique per scope;
   - conflicting writes are reported rather than silently overwriting memory;
   - changes to keyed facts require explicit `memory_update`.

## Tools

| Tool | Purpose |
|---|---|
| `memory_write` | Store a durable fact, deduplicate it, or report a canonical-key conflict |
| `memory_update` | Correct text/metadata/key/scope or archive/restore in place |
| `memory_search` | FTS5 retrieval across all scopes or one exact scope; archive history is optional |
| `memory_review` | Find likely duplicate pairs and stale candidates |
| `memory_forget` | Permanently delete an obsolete memory |

## Schema v4

The current record includes:

| Field | Purpose |
|---|---|
| `text` | Self-contained durable fact |
| `tags` | Searchable labels |
| `pinned` | Always prioritize in visible recall |
| `importance` | 1–5 durability/relevance |
| `scope` | Isolation key |
| `memory_key` | Optional canonical fact identity |
| `created_at` | Creation timestamp |
| `updated_at` | Last content/metadata change |
| `last_accessed` | Last explicit search retrieval |
| `access_count` | Explicit retrieval count |
| `archived` | Removes memory from active use without deleting |
| `archived_at` | Archive timestamp |

Automatic migrations are supported:

```text
v1 -> v4
v2 -> v4
v3 -> v4
```

FTS5 is rebuilt during migration, so derived search state is repaired as part of the upgrade.

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

Decay only reduces the recency bonus. It never deletes knowledge.

## Importance

Recommended meaning:

```text
1 = low-value contextual fact
2 = useful but replaceable
3 = normal durable memory
4 = important durable decision/preference
5 = critical long-lived fact
```

Pinned and importance-5 memories are protected from stale candidacy.

## Scopes

Recommended forms:

```text
global
project:mana-ponte
project:dsh-memory
workspace:university
```

Deduplication and canonical-key uniqueness are scoped. A key may therefore exist once in `global` and independently once in `project:foo`.

When `promptScope` is non-global, automatic recall sees:

```text
global + active scope
```

## Canonical keys

Keys are optional. They are useful when a fact has one clear identity that may change over time.

Examples:

```text
environment.shell
environment.os
project.runtime
project.package-manager
user.editor
```

Example write:

```text
memory_write(
  text = "The project runtime is Node 22",
  scope = "project:example",
  key = "project.runtime"
)
```

If another write tries:

```text
key  = "project.runtime"
text = "The project runtime is Node 24"
```

the plugin **does not overwrite Node 22** and does not create a second active keyed memory. It returns a conflict pointing to the existing memory.

The model must then deliberately call:

```text
memory_update(existing_id, text = "The project runtime is Node 24")
```

This gives deterministic conflict detection without asking another LLM to decide which fact is true.

Equivalent text using the same key is deduplicated normally.

## Archive vs delete

Archive:

```text
memory_update(id, archived = true)
```

An archived memory:

- remains in SQLite;
- keeps its id/key/metadata;
- is excluded from active prompt recall;
- is excluded from normal search;
- is excluded from active deduplication and key uniqueness;
- can be retrieved with `includeArchived=true`;
- can be restored with `archived=false`.

Restoration reruns active duplicate/key checks. If a newer active replacement exists, restoration is rejected.

Permanent deletion remains:

```text
memory_forget(id)
```

## Stale review

`memory_review` reports stale candidates after `staleAfterDays`.

It never archives or deletes automatically.

A safe lifecycle is:

```text
memory_review
      |
      +-- duplicate candidate -> memory_update / memory_forget
      |
      +-- stale candidate ----> memory_update(archived=true)
      |
      +-- changed keyed fact -> memory_update(existing_id, ...)
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

All curation uses:

- SQLite;
- FTS5;
- Unicode normalization;
- token-set Jaccard similarity;
- timestamps/counters;
- unique partial indexes;
- deterministic ranking and lifecycle rules.

The model already running in DSH decides what deserves memory and when to use the tools. No second LLM or embedding model needs to stay in RAM/VRAM.

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
