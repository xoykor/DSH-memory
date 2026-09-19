# Changelog

All notable changes to this fork are documented here.

## 0.7.1

- Fixed bundle loading in profiles that set `autoInstallPeers: false`.
- Removed the runtime import of `@deepseek-ai/dsh-tools`; memory tools now register through DSH's supported raw JSON-Schema ToolDefinition interface.
- The distributed package is now self-contained apart from its normal `@deepseek-ai/schemastery` dependency.
- Development compatibility is pinned to the DSH `0.1.5-rc.2` API used by the target backup profile.
- Added a standalone compatibility check that installs the packed bundle without DSH peer packages and verifies import plus bundle composition against DSH `0.1.5-rc.2`.
- Database schema remains v4; no migration is required.

## 0.7.0

- Added configurable `memoryPolicy`: `minimal`, `guided`, and `strict`.
- `guided` is now the default bundle policy.
- The policy is injected into the system prompt independently of recall, so the model is reminded how to use memory even when the database is empty.
- Guided mode tells the active model when to use `memory_search`, `memory_write`, and `memory_update`, while explicitly discouraging unnecessary calls.
- Strict mode adds stronger task-boundary checks and canonical-key guidance.
- Minimal mode preserves recall-only behavior with no extra memory-tool instructions.
- Added policy prompt regression tests, including rejection of unknown policy names.
- No schema migration is required; the database remains schema v4.

## 0.6.0

- Added `memory_stats`, a read-only memory-health summary.
- Reports active, archived, pinned, keyed and stale counts.
- Reports distribution by scope and importance.
- Stats do not increment retrieval counters or bias recall ranking.
- Canonical identity now takes precedence over lexical similarity: two different non-empty keys are never merged merely because their text is similar.
- Archived history can be edited without active-memory deduplication blocking the edit.

## 0.5.0

- Added optional canonical memory keys.
- Active keys are unique per scope.
- Same-key equivalent writes deduplicate.
- Same-key materially different writes report a conflict instead of silently overwriting memory.
- Added explicit keyed updates and key-conflict checks.
- Added automatic schema v3 -> v4 migration.
- FTS5 is rebuilt during every supported schema migration.

## 0.4.0

- Added non-destructive archive/restore lifecycle.
- Archived memories leave normal recall, search and deduplication while remaining durable.
- Added explicit historical search with `includeArchived`.
- Restoration re-runs active duplicate checks.
- Added automatic schema v2 -> v3 migration.

## 0.3.0

- Added importance 1-5.
- Added access counters and last-access timestamps.
- Added deterministic recall ranking with a decaying recency bonus.
- Added memory scopes and global + active-scope prompt recall.
- Added stale-memory review candidates without automatic deletion.
- Added automatic schema v1 -> v2 migration.

## 0.2.0

- Forked the lightweight SQLite + FTS5 architecture of `ben7am1n/dsh-memory`.
- Added normalized exact deduplication.
- Added high-confidence token-set Jaccard deduplication.
- Added `memory_update`.
- Added `memory_review`.
- Added CI for Node 22.19 and Node 24.

## Upstream

The original `ben7am1n/dsh-memory` project is MIT licensed. This fork preserves the same offline-first principle: no embedding service, API key, sidecar process or second model is required.
