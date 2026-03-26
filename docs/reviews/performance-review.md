# Performance Review — NanoClaw on Cloud

**Date:** 2026-03-26
**Reviewer:** Performance Reviewer (Automated)
**Scope:** All packages — shared, control-plane, agent-runtime, web-console, infra

---

## Summary

The codebase has a solid performance foundation: SQS FIFO with per-message-group-ID throughput, DynamoDB on-demand billing, bot-level TTL caching, AWS SDK client reuse at module scope, and long-polling SQS consumers with semaphore-based concurrency control. However, several areas have meaningful optimization potential, ranging from critical N+1 query patterns in admin endpoints to missing caching in the hot dispatch path.

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 6 |
| Medium | 8 |
| Low | 5 |

---

## Critical

### PERF-C1: N+1 DynamoDB Queries in Admin User List

**File:** `control-plane/src/routes/api/admin.ts:152-175`
**Impact:** Critical

The `GET /api/admin` endpoint calls `listAllUsers()` (a full table scan), then for *each* user calls `listBots(userId)` in a `Promise.all` loop. With N users, this produces N+1 DynamoDB operations:

```typescript
const users = await listAllUsers();         // 1 Scan (paginated)
const results = await Promise.all(
  users.map(async (u) => {
    const bots = await listBots(u.userId);  // N Queries
    ...
  }),
);
```

At 100 users this is 101+ DynamoDB calls per admin page load. At 1000 users this will hit DynamoDB throughput limits and cause multi-second response times.

**Recommendation:**
- Use a single scan on the bots table to count bots per user, or maintain a `botCount` attribute on the user record (updated on bot create/delete).
- Alternatively, use `BatchGetItem` or a GSI on the bots table with projection to minimize read cost.
- The same N+1 exists in the single-user `GET /api/admin/:userId` endpoint (line 178-199), though it's only 2 calls per request.

---

### PERF-C2: Full Table Scans for Channel Discovery (Discord, Feishu, DingTalk)

**Files:**
- `control-plane/src/discord/gateway-manager.ts:373-394` — `discoverDiscordChannels()`
- `control-plane/src/feishu/gateway-manager.ts:203-211` — `discoverFeishuChannels()`
- `control-plane/src/dingtalk/gateway-manager.ts:435-453` — `discoverDingTalkChannels()`

All three gateway managers discover channels via a full `ScanCommand` on the channels table with a `FilterExpression` for `channelType`. DynamoDB scans read every item in the table and then apply the filter client-side, meaning you pay for the full table's read capacity even if only 5 out of 1000 channels are Discord/Feishu/DingTalk.

Additionally, `discoverDiscordChannels()` creates **new** `DynamoDBClient` and `DynamoDBDocumentClient` instances every time it's called (via dynamic `import()` at lines 377-383), which defeats connection pooling and adds import overhead.

**Recommendation:**
- Add a GSI `channelType-index` (partition key: `channelType`, sort key: `botId`) to the channels table. This converts all three scans into efficient queries.
- Use the module-level DynamoDB client from `services/dynamo.ts` instead of creating new ones.
- The DingTalk manager already paginates its scan (good), but Discord and Feishu do not — large tables will return truncated results.

---

## High

### PERF-H1: Uncached `getPlanQuotas()` Called on Every User Provision

**File:** `control-plane/src/services/dynamo.ts:929-937`

`getPlanQuotas()` is called by `ensureUser()`, `updateUserPlan()`, and `createUserRecord()`. The `ensureUser()` function runs on **every inbound message** in the dispatch path (`dispatcher.ts:283`). Each call makes a DynamoDB `GetItem` to the sessions table.

Plan quotas change extremely rarely (admin action only), but this read happens on every single message through the system.

**Recommendation:**
- Cache plan quotas in the existing `TtlCache` with a 5-10 minute TTL. Invalidate on `savePlanQuotas()`.
- This would eliminate one DynamoDB read per message dispatch.

---

### PERF-H2: Redundant DynamoDB Reads in Dispatch Path

**File:** `control-plane/src/sqs/dispatcher.ts:269-476`

The `dispatchMessage()` function makes 8-10 sequential DynamoDB/Secrets Manager calls before invoking the agent. Several could be parallelized or cached:

1. `getCachedBot()` — cached (good)
2. `ensureUser()` — reads user + calls `getPlanQuotas()` (2 reads)
3. `checkAndAcquireAgentSlot()` — reads user again + conditional update (2 reads)
4. `getGroup()` — uncached read
5. `getRecentMessages()` — uncached read
6. `buildFeishuConfig()` → `getChannelsByBot()` — uncached read
7. `resolveProviderCredentials()` → `getProvider()` — uncached read
8. `buildProxyRules()` → `getProxyRules()` — Secrets Manager read
9. `getSession()` — uncached read

Steps 4-9 have no dependencies on each other and could be parallelized with `Promise.all()`. Steps 2-3 read the user record twice (once in `ensureUser`, once in `checkAndAcquireAgentSlot`).

**Recommendation:**
- Parallelize independent lookups (group, messages, channels, provider, proxy rules, session) using `Promise.all()`.
- Pass the user record from `ensureUser()` to `checkAndAcquireAgentSlot()` to avoid the redundant read.
- Cache `getGroup()` and `getProvider()` results (5-min TTL) since they change infrequently.
- **Estimated improvement:** 40-60% latency reduction in the pre-invocation setup phase.

---

### PERF-H3: SQS Client Created Per MCP Tool Call

**File:** `agent-runtime/src/mcp-tools.ts:72, 140`

The `sendMessage()` and `sendFile()` MCP tool implementations create a `new SQSClient({})` on every invocation. During a single agent run, the agent may call `send_message` dozens of times, each spinning up a new HTTP/2 connection.

**Recommendation:**
- Create the SQS client at module scope (like the control-plane does), or lazily initialize a singleton.

---

### PERF-H4: STS AssumeRole + Diagnostic Calls on Every Invocation

**File:** `agent-runtime/src/scoped-credentials.ts:34-93`

Every agent invocation calls `getScopedClients()`, which:
1. `AssumeRole` (required)
2. `GetCallerIdentity` with scoped creds (diagnostic only)
3. `ListObjectsV2` with scoped creds (diagnostic only)

Steps 2-3 are debug diagnostics (`[ABAC-DEBUG]`) that add ~200-400ms latency per invocation. They also create a temporary `STSClient` that's immediately discarded.

**Recommendation:**
- Remove or gate the diagnostic calls behind a `DEBUG` environment variable. They are not needed in production.
- Cache scoped credentials for the same `(userId, botId)` pair within the session (they last 1 hour, invocations within the same session can reuse them).
- **Estimated improvement:** 200-400ms per agent invocation.

---

### PERF-H5: Sequential S3 File Operations in Session Sync

**Files:** `agent-runtime/src/session.ts:197-226, 251-323`

`downloadDirectory()` and `uploadDirectory()` process files **sequentially** — each file is a separate S3 `GetObject`/`PutObject` call awaited one at a time. For sessions with 20+ files (common after several conversations), this creates a waterfall of sequential network round-trips.

`clearSessionDirectory()` also deletes objects one at a time (line 106-108).

**Recommendation:**
- Use `Promise.all()` with a concurrency limiter (e.g., batches of 10) for both download and upload operations.
- For `clearSessionDirectory()`, use `DeleteObjectsCommand` (batch delete up to 1000 objects per call) instead of individual deletes.
- **Estimated improvement:** 3-5x faster session sync for typical workloads.

---

### PERF-H6: Missing Pagination in Health Check Channel Scan

**File:** `control-plane/src/services/dynamo.ts:628-636`

`getChannelsNeedingHealthCheck()` includes a `ScanCommand` for unchecked channels (line 628) that does not handle pagination (`LastEvaluatedKey`). If the channels table exceeds 1MB of unchecked items, results will be silently truncated.

The two `QueryCommand` calls above it (lines 591-624) also lack pagination, though GSI queries are less likely to exceed 1MB.

**Recommendation:**
- Add pagination loops (like `listAllUsers` and `listProviders` do) to ensure all results are retrieved.

---

## Medium

### PERF-M1: `listAllUsers()` and `listProviders()` Use Full Table Scans

**Files:**
- `control-plane/src/services/dynamo.ts:243-257` — `listAllUsers()`
- `control-plane/src/services/dynamo.ts:970-984` — `listProviders()`

Both functions scan their entire respective tables. While acceptable at small scale (dozens of users/providers), these will degrade linearly with table size.

**Recommendation:**
- For providers: cache the full list in memory (providers change rarely, admin-only operations).
- For users: add pagination support to the API (`limit` + `lastKey` params) rather than returning all users in one response.

---

### PERF-M2: `clearDefaultProvider()` Scans + Sequential Updates

**File:** `control-plane/src/services/dynamo.ts:1049-1058`

Setting a new default provider first scans all providers, filters for defaults, then updates each one sequentially. With many providers this is N+1 operations.

**Recommendation:**
- Maintain a single `__system__/default-provider` record in the sessions table to track the default, avoiding the scan-and-update pattern.

---

### PERF-M3: TtlCache Never Evicts Expired Entries Proactively

**File:** `control-plane/src/services/cache.ts:12-55`

The `TtlCache` only evicts expired entries on `get()` access or `size` property check. Entries that are set but never read again will persist in memory indefinitely until the process restarts.

For long-running control-plane processes (days/weeks on ECS), this is a slow memory leak for bots/channels that are accessed once then go idle.

**Recommendation:**
- Add a periodic sweep (e.g., every 10 minutes via `setInterval`) that removes expired entries.
- Alternatively, set a maximum cache size and use LRU eviction.

---

### PERF-M4: Attachment Download Buffers Entire File in Memory

**Files:**
- `control-plane/src/services/attachments.ts:21-23` — `Buffer.from(await res.arrayBuffer())`
- `agent-runtime/src/agent.ts:696-698` — `await resp.Body.transformToByteArray()`
- `control-plane/src/sqs/reply-consumer.ts:95-97` — `Buffer.from(await resp.Body.transformToByteArray())`

All file operations buffer the entire file contents in memory before uploading to S3 or writing to disk. While the 20MB limit caps the worst case, this means peak memory usage spikes by the file size during transfers.

**Recommendation:**
- Use S3 upload streams (`Upload` from `@aws-sdk/lib-storage`) for the control-plane attachment path.
- In the agent-runtime, pipe the S3 `Body` stream directly to `fs.createWriteStream()` instead of buffering.
- In the reply consumer, stream the S3 body directly to the channel adapter.

---

### PERF-M5: No Code Splitting or Lazy Loading in Web Console

**File:** `web-console/src/App.tsx:1-48`

All pages are eagerly imported at the top of `App.tsx`:
```typescript
import Dashboard from './pages/Dashboard';
import BotDetail from './pages/BotDetail';
import ChannelSetup from './pages/ChannelSetup';
// ... all imported eagerly
```

The entire application is loaded in a single JavaScript bundle. Admin pages (UserList, UserDetail) are loaded even for non-admin users. Heavy pages like MemoryEditor and BotDetail are loaded on the dashboard.

**Recommendation:**
- Use `React.lazy()` with `Suspense` for route-level code splitting:
  ```typescript
  const BotDetail = React.lazy(() => import('./pages/BotDetail'));
  ```
- This is especially impactful for admin pages and the heavy BotDetail component.
- The Vite config (`web-console/vite.config.ts`) has no `build.rollupOptions.output.manualChunks` — consider splitting vendor libraries (react, aws-amplify, lucide-react).

---

### PERF-M6: Vite Build Missing Production Optimizations

**File:** `web-console/vite.config.ts`

The Vite config is minimal — just the React plugin and dev proxy. It lacks:
- `build.rollupOptions.output.manualChunks` for vendor splitting
- Terser minification configuration
- `build.sourcemap` control for production
- No chunk size warnings configured

**Recommendation:**
- Add manual chunks to split large vendor libraries:
  ```typescript
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          amplify: ['aws-amplify', '@aws-amplify/ui-react'],
        }
      }
    }
  }
  ```

---

### PERF-M7: Reply Consumer Creates Clients Inside Loop

**File:** `control-plane/src/sqs/reply-consumer.ts:35-36`

The SQS and S3 clients are created inside `replyLoop()`, which is called once per consumer start. While this isn't per-message, these clients are local variables rather than module-scope singletons. If `replyLoop` is restarted (e.g., after a crash), new client instances are created while the old ones may still hold connections.

**Recommendation:**
- Move SQS and S3 client creation to module scope, consistent with how the main SQS consumer (`consumer.ts:16`) does it.

---

### PERF-M8: Webhook Handler Queries Channels List to Find Telegram Channel

**File:** `control-plane/src/webhooks/telegram.ts:133-136`

On every Telegram webhook, `getChannelsByBot(botId)` queries all channels for the bot, then filters for `channelType === 'telegram'`. This is fine for bots with 1-3 channels but wasteful — the webhook already knows the channel type.

**Recommendation:**
- Add a direct lookup function `getChannel(botId, 'telegram', channelId)` or use the existing `getChannel()` if the channelId is known.
- Cache the telegram channel config per botId (it changes only on channel create/delete).

---

## Low

### PERF-L1: `getOrCreateGroup()` Always Updates `lastMessageAt`

**File:** `control-plane/src/services/dynamo.ts:656-708`

Every inbound message calls `getOrCreateGroup()`, which unconditionally does a `GetItem` + `UpdateItem` (2 DynamoDB operations) even when the group already exists. The update just sets `lastMessageAt` and `name`.

**Recommendation:**
- Only update if `lastMessageAt` is older than some threshold (e.g., 5 minutes), or move the timestamp update to a less critical path.

---

### PERF-L2: Zod Schema Validation on Every DynamoDB Key Access

**Files:** `control-plane/src/services/dynamo.ts` — `userIdSchema.parse()`, `botKeySchema.parse()`, `z.string().min(1).parse()` throughout

Every DynamoDB read/write call runs Zod validation on the key parameters. While individually cheap (~0.01ms each), across the entire request lifecycle with 10+ DynamoDB calls, this adds up. These IDs are already validated at the API boundary (route handlers).

**Recommendation:**
- Trust internal callers and remove redundant Zod validation from the DynamoDB service layer, or use a debug-only assertion.

---

### PERF-L3: `checkAndAcquireAgentSlot()` Makes 3 DynamoDB Calls

**File:** `control-plane/src/services/dynamo.ts:156-216`

The agent slot acquisition does:
1. `GetItem` to check stale slots
2. Conditional `UpdateItem` to reset stale slots (if needed)
3. Conditional `UpdateItem` to acquire the slot

This could be reduced to 1-2 calls in the common case (no stale slots).

**Recommendation:**
- Combine the stale-slot check into the acquire conditional expression, or use a single UpdateCommand with a more complex ConditionExpression that handles both cases.

---

### PERF-L4: Telegram Webhook Calls `listGroups()` for Quota Check

**File:** `control-plane/src/webhooks/telegram.ts:220-229`

Every message from a new chat calls `listGroups(botId)` to count groups for quota enforcement. This queries all groups for the bot just to check a count.

**Recommendation:**
- Maintain a `groupCount` attribute on the bot record (incremented on group creation), or use the `Select: 'COUNT'` option in the query.

---

### PERF-L5: DynamoDB DocumentClient `removeUndefinedValues` Option

**File:** `control-plane/src/services/dynamo.ts:32-34`

```typescript
const client = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});
```

This is correct and prevents marshalling errors, but it means every item sent to DynamoDB is traversed to strip undefined values. For large items (e.g., messages with long content or many attributes), this adds minor overhead.

**Recommendation:**
- No action needed — the safety benefit outweighs the trivial performance cost. Noted for completeness.

---

## Positive Patterns (No Action Needed)

These patterns are well-implemented and deserve recognition:

1. **Bot cache with TTL** (`services/cache.ts`, `services/cached-lookups.ts`): Hot-path bot lookups are cached with configurable TTL, reducing DynamoDB reads significantly.

2. **Module-scope AWS SDK clients** (`services/dynamo.ts`, `sqs/consumer.ts`, etc.): Most SDK clients are created at module scope, enabling HTTP/2 connection reuse across requests.

3. **SQS FIFO per-message-group-ID throughput** (`infra/lib/foundation-stack.ts:87-88`): `fifoThroughputLimit: PER_MESSAGE_GROUP_ID` enables high-throughput parallel processing across groups.

4. **Semaphore-based concurrency control** (`sqs/consumer.ts:75-103`): The SQS consumer uses a counting semaphore to bound concurrent dispatches, preventing resource exhaustion.

5. **Long-polling SQS** (`consumer.ts:119`, `reply-consumer.ts:44`): Both consumers use 20-second long polls, minimizing empty receives and reducing SQS costs.

6. **DynamoDB on-demand billing** (`infra/lib/foundation-stack.ts:103-104`): `PAY_PER_REQUEST` billing avoids capacity planning issues and scales automatically.

7. **S3 lifecycle rules** (`infra/lib/foundation-stack.ts:60-69`): Automatic transition to Infrequent Access after 90 days reduces storage costs.

8. **Message TTL** (`services/dynamo.ts:37-39`): 90-day TTL on messages prevents unbounded table growth.

9. **Graceful SQS shutdown** (`sqs/consumer.ts:39-72`): In-flight message tracking with visibility timeout release prevents message loss during deployments.

10. **Content-based deduplication** (`infra/lib/foundation-stack.ts:89`): FIFO queue content-based dedup prevents duplicate message processing without client-side tracking.

---

## Priority Recommendations

### Quick Wins (< 1 day each)
1. **PERF-H4**: Remove ABAC debug diagnostics in scoped-credentials.ts (200-400ms/invocation saved)
2. **PERF-H3**: Move SQS client to module scope in mcp-tools.ts
3. **PERF-M7**: Move reply consumer clients to module scope

### Medium Effort (1-3 days each)
4. **PERF-H2**: Parallelize dispatch path DynamoDB reads with `Promise.all()`
5. **PERF-H5**: Parallelize S3 session sync with batched concurrency
6. **PERF-H1**: Cache plan quotas
7. **PERF-M5**: Add React.lazy() code splitting to web-console

### Larger Effort (3-5 days)
8. **PERF-C1**: Eliminate N+1 in admin user list (denormalize bot count or batch query)
9. **PERF-C2**: Add channelType GSI and replace all channel discovery scans
