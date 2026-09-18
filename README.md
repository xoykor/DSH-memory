# DSH-memory

Curated durable memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This repository starts from the lightweight design of [ben7am1n/dsh-memory](https://github.com/ben7am1n/dsh-memory): one local SQLite database with FTS5, no embedding service, no API key, and no sidecar model.

This fork adds deterministic curation while keeping that architecture small:

- exact and high-confidence lexical deduplication before writes;
- `memory_update` for correcting durable facts instead of accumulating stale copies;
- importance (1-5), access counters, and last-access timestamps;
- prompt selection that considers importance and actual retrieval use;
- `memory_review` for bounded duplicate/stale-memory review;
- schema migration from the original v1 database;
- no second LLM and no embedding model.

## Status

Initial curated implementation is being built directly in this repository. The storage format remains SQLite + FTS5 and is intended to stay offline-first.

## License and upstream

MIT. Based on the MIT-licensed architecture/code of `ben7am1n/dsh-memory`; see `LICENSE` and the upstream repository for the original project.
