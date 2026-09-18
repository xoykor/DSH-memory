# DSH-memory

Curated durable memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This fork keeps the lightweight architecture of [ben7am1n/dsh-memory](https://github.com/ben7am1n/dsh-memory): one local SQLite file with FTS5, **no embedding service, no API key, no sidecar process, and no second model**.

## First curation layer

| Tool | Purpose |
|---|---|
| `memory_write` | Stores durable facts and suppresses exact/high-confidence lexical duplicates |
| `memory_update` | Corrects an existing memory in place |
| `memory_search` | FTS5 keyword retrieval |
| `memory_review` | Read-only bounded scan for likely duplicate pairs |
| `memory_forget` | Deletes obsolete memories |

Deduplication uses normalized Unicode text plus token-set Jaccard similarity. The automatic threshold defaults to `0.90`; review defaults to `0.65` and never mutates data.

## Configuration

The existing database schema remains unchanged and compatible with upstream v1.

```yaml
dedupSimilarityThreshold: 0.90
reviewSimilarityThreshold: 0.65
reviewScanLimit: 1000
```

## Roadmap

Next: importance, access-frequency ranking, stale-memory decay and scopes. Those require a schema migration and will be added separately.

## License / upstream

MIT. Based on the MIT-licensed `ben7am1n/dsh-memory`.
