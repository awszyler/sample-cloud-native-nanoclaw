# Critical Performance Fixes Design

**Date:** 2026-03-26
**Scope:** 2 Critical findings from `docs/reviews/performance-review.md`
**Status:** Approved

---

## PERF-C1: Denormalize botCount on User Record

**File:** `control-plane/src/routes/api/admin.ts:152-175`

**Problem:** Admin user list does N+1 DynamoDB calls — 1 scan + N `listBots()` queries.

**Fix:**
1. Update `createBot()` to atomically increment `botCount` on the user record
2. Update `deleteBot()` to atomically decrement `botCount` on the user record
3. Simplify admin endpoints to use `user.botCount ?? 0` directly (no more `listBots()` per user)
4. Lazy backfill — existing users show 0 until their next bot create/delete

---

## PERF-C2: channelType GSI + Fix Discord Client

**Files:**
- `infra/lib/foundation-stack.ts` — add GSI
- `control-plane/src/services/dynamo.ts` — add `getChannelsByType()`
- `control-plane/src/discord/gateway-manager.ts` — use shared function
- `control-plane/src/feishu/gateway-manager.ts` — use shared function
- `control-plane/src/dingtalk/gateway-manager.ts` — use shared function

**Problem:** Three gateway managers scan the entire channels table with FilterExpression. Discord also creates new DynamoDB client instances via dynamic import on every call.

**Fix:**
1. Add `channelType-index` GSI (PK: channelType, SK: botId) to channels table
2. Add shared `getChannelsByType(type)` in dynamo.ts with pagination
3. Replace all three gateway managers' scan functions with `getChannelsByType()`
4. Discord: remove dynamic import + new client creation

---

## Files Changed Summary

| File | Change |
|------|--------|
| `infra/lib/foundation-stack.ts` | Add channelType-index GSI |
| `control-plane/src/services/dynamo.ts` | Add getChannelsByType(), update createBot()/deleteBot() for botCount |
| `control-plane/src/routes/api/admin.ts` | Remove N+1 pattern, use user.botCount |
| `control-plane/src/discord/gateway-manager.ts` | Replace discoverDiscordChannels() with getChannelsByType() |
| `control-plane/src/feishu/gateway-manager.ts` | Replace discoverFeishuChannels() with getChannelsByType() |
| `control-plane/src/dingtalk/gateway-manager.ts` | Replace discoverDingTalkChannels() with getChannelsByType() |
| `shared/src/types.ts` | Add optional botCount to User type |
