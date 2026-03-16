# Discord Gateway Integration Design

**Date**: 2026-03-16
**Status**: Approved

## Problem

Discord Interactions Endpoint (webhook) only receives slash commands and interaction events, not regular messages. The bot appears offline and cannot respond to @mentions or channel messages. Discord requires a Gateway WebSocket connection for MESSAGE_CREATE events.

## Solution

Embed a `discord.js` Gateway connection inside the existing control-plane ECS service with DynamoDB-based leader election to handle multi-replica safety.

## Architecture

### Data Flow

```
Discord user message
  -> Gateway WebSocket (discord.js Client, leader instance only)
  -> DiscordGatewayManager.onMessage()
  -> putMessage() + SQS FIFO dispatch
  -> dispatcher -> AgentCore -> reply queue
  -> reply-consumer -> Discord REST API sendMessage()
```

Reply path uses existing REST API (`channels/discord.ts`), not Gateway. This keeps replies working even if Gateway is temporarily disconnected.

Existing Interactions Endpoint webhook retained for ping verification only.

### Leader Election

Uses DynamoDB conditional writes on the Sessions table (no new tables):

```
PK: "__system__"
SK: "discord-gateway-leader"
leaderId: "<ECS task ID>"
expiresAt: <TTL timestamp, 60s>
```

- **Acquire**: `PutItem` with `ConditionExpression` (record not exists OR expired)
- **Renew**: Leader updates `expiresAt` every 30s
- **Failover**: Standby polls every 30s, acquires lock when expired
- **Release**: On SIGTERM, explicitly delete lock + `client.destroy()`

### DiscordGatewayManager Lifecycle

**Startup** (in `main()`, alongside SQS consumers):

1. Query channels table for `channelType=discord` records
2. No Discord channels -> skip entirely (no lock, no connection)
3. Has Discord channels -> compete for leader lock
4. Leader: fetch bot token from Secrets Manager -> `discord.js` Client login
5. Standby: poll lock every 30s

**Runtime**:

- Leader: maintain Gateway connection + renew lock every 30s
- Standby: check lock expiry every 30s, take over if expired
- New Discord channel added via web console: trigger Gateway re-initialization

**Shutdown** (SIGTERM):

- Release DynamoDB lock
- `client.destroy()` to disconnect Gateway
- Called alongside `stopSqsConsumer()` and `stopReplyConsumer()`

### MESSAGE_CREATE Handler

1. Filter: ignore bot messages (`message.author.bot`), empty messages
2. Build identifiers: `groupJid = "dc:{channelId}"`, `messageId = "dc-{message.id}"`
3. @mention translation: detect `<@botUserId>`, convert to trigger text
4. Attachments: reuse existing `downloadAndStore()` for S3 upload
5. Store + dispatch: `putMessage()` to DynamoDB + `SendMessageCommand` to SQS FIFO

Shared conversion logic extracted from existing `webhooks/discord.ts` to avoid duplication.

## Changes

| File | Action | Description |
|------|--------|-------------|
| `control-plane/package.json` | Modify | Add `discord.js` dependency |
| `control-plane/src/discord/gateway-manager.ts` | New | Leader election + Client lifecycle |
| `control-plane/src/discord/message-handler.ts` | New | MESSAGE_CREATE -> SQS dispatch |
| `control-plane/src/index.ts` | Modify | Add start/stop Discord gateway |
| `control-plane/src/webhooks/discord.ts` | Modify | Simplify to ping verification only |

No CDK/infrastructure changes. No new DynamoDB tables, SQS queues, or IAM permissions required.

## Dependencies

- `discord.js` ^14.16 (pure JS, no native modules)

## Risks

- **Gateway disconnect during ECS rolling deploy**: Lock TTL (60s) ensures standby takes over within ~90s worst case. Discord session resume minimizes reconnection time.
- **Rate limits**: Discord Gateway has rate limits on identify (1 per 5s). Leader election prevents multiple connections from competing.
