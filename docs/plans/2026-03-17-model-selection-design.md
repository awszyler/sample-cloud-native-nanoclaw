# Bot Model Selection

## Goal

Allow users to choose which Bedrock model their Bot uses, via the web console. Default: `global.anthropic.claude-sonnet-4-6`.

## Data Model

**Bot** (shared/src/types.ts):
```typescript
model?: string;  // Bedrock model ID
```

**InvocationPayload** (shared/src/types.ts):
```typescript
model?: string;
```

No DynamoDB migration needed — schemaless. Old bots without `model` field fall back to default in agent-runtime.

## Preset Models

| Label | Model ID |
|-------|----------|
| Claude Haiku 4.5 | `global.anthropic.claude-haiku-4-5-20251001-v1:0` |
| Claude Sonnet 4.6 | `global.anthropic.claude-sonnet-4-6` |
| Claude Opus 4.6 | `global.anthropic.claude-opus-4-6-v1` |
| Custom | User-entered model ID |

Default: Claude Sonnet 4.6

## Scope

Bot-level setting. All groups/channels under a bot share the same model.

## Data Flow

```
Web Console (BotDetail) → PUT /bots/:botId { model } → DynamoDB Bot record
                                                              ↓
Agent Runtime ← InvocationPayload.model ← Dispatcher reads bot.model
      ↓
query({ options: { model: payload.model || DEFAULT_MODEL } })
```

## Changes

| File | Change |
|------|--------|
| `shared/src/types.ts` | Add `model?: string` to Bot and InvocationPayload |
| `control-plane/src/services/dynamo.ts` | Add `'model'` to updateBot allowedFields |
| `control-plane/src/routes/api/bots.ts` | Add `model` to create/update Zod schemas |
| `control-plane/src/sqs/dispatcher.ts` | Pass `bot.model` in InvocationPayload |
| `agent-runtime/src/agent.ts` | Pass `payload.model \|\| DEFAULT_MODEL` to query options |
| `web-console/src/pages/BotDetail.tsx` | Add model selector UI (preset radio + custom input) |
| `web-console/src/lib/api.ts` | Add `model` to CreateBotRequest type (optional) |
