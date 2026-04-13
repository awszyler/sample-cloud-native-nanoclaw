# ECS Mode: S3 Incremental Sync

**Status:** Planned (not started)
**Date:** 2026-04-12

## Problem

In ECS dedicated task mode, each botId#groupJid gets its own long-lived Fargate task. Currently every `/invocations` request does a full cycle: `cleanLocalWorkspace()` → `syncFromS3()` → run agent → `syncToS3()`. Since the task is dedicated to one session, files from the previous request are already on local disk — re-downloading everything is wasteful, especially the session state (conversation history JSONL) which is the largest component.

## Design

### SyncState tracker (in-process memory)

A `SyncState` singleton in `session.ts` tracks:
- `initialized: boolean` — whether first full sync has completed
- `etags: Map<string, string>` — S3 key → ETag from last download/upload

Pure in-memory, not persisted. Task restart naturally falls back to full sync.

### Three sync paths

| Condition | Behavior |
|-----------|----------|
| First request / agentcore mode | Full clean + sync (current logic, unchanged) |
| ECS subsequent + forceNewSession | Full clean + clear S3 session + memory-only download |
| **ECS subsequent (normal)** | **Incremental: skip clean, skip session download, ETag-check memory** |

### Incremental path details

On subsequent ECS requests (not first, not forceNewSession):

1. **Skip** `cleanLocalWorkspace()` — same session, no cross-tenant risk
2. **Skip** session state download — only this task writes to it, local is authoritative
3. **HeadObject** check botClaude ETag — re-download only if changed (web console edit)
4. **ListObjectsV2** compare group workspace / learnings ETags — download only changed files
5. **Skills** always re-download (may be updated via web console)
6. **Upload** unchanged — still full upload to S3 for durability (task may stop anytime)

### ETag recording

Both `syncFromS3()` (full path) and `syncToS3()` record ETags into `syncState` after each file operation, providing the baseline for subsequent incremental checks.

### New functions in session.ts

- `downloadFileIfChanged(s3, bucket, key, localPath, logger)` — HeadObject ETag check, download only if changed
- `downloadDirectoryIncremental(s3, bucket, prefix, localDir, logger)` — ListObjectsV2 ETag comparison, download only changed/new files
- `incrementalSyncFromS3(s3, bucket, paths, logger)` — orchestrates the above, skipping session state entirely

### forceNewSession handling

`forceNewSession` (model/provider change) takes the full path but calls `syncState.clearSessionEtags(prefix)` to invalidate cached ETags for session state. `initialized` stays true.

## Expected Impact

- Eliminates session state download on subsequent requests (largest S3 transfer)
- Reduces botClaude check to a single HeadObject call (~3ms vs full GetObject)
- Group workspace / learnings only transfer changed files
- No behavior change for agentcore mode
