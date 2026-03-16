# Channel Adapter Abstraction + Discord Slash Commands

**Date:** 2026-03-16
**Status:** Approved
**Scope:** Channel Adapter interface, Discord Adapter refactor, Slash Commands, Embed replies

## Background

### Current State
- Telegram/Slack/Discord message handling scattered across `webhooks/`, `channels/`, `discord/` directories
- No unified adapter interface — each channel is wired ad-hoc
- Discord replies are plain `{ content }` text, no embeds or slash commands
- Adding platform-specific features requires changes in multiple unrelated files

### Reference: OpenClaw Discord Integration
Key features OpenClaw has that we lack (ranked by value):

| Priority | Feature | Complexity |
|----------|---------|------------|
| **P0** | Slash Commands (`/ask`, `/status`, `/help`) | Medium |
| **P0** | Channel Adapter abstraction | Medium |
| **P1** | Embed-formatted replies | Low |
| **P1** | Typing indicator during agent processing | Low |
| **P2** | Thread binding (independent session per thread) | Medium |
| **P2** | DM policy management (pairing/allowlist/open/disabled) | Low |
| **P2** | Reaction event handling | Low |
| **P3** | Interactive components (buttons/selects/modals) | High |
| **P3** | Exec approvals via Discord buttons | High |
| **P3** | Streaming replies (edit message as tokens arrive) | High |

**This design covers P0 + P1.** P2/P3 deferred to future iterations.

## Design

### 1. Channel Adapter Interface

Located in `shared/src/channel-adapter.ts`:

```typescript
export interface ReplyContext {
  botId: string;
  groupJid: string;
  channelType: 'discord' | 'slack' | 'telegram';
  // Discord-specific
  discordChannelId?: string;
  discordInteractionToken?: string; // slash command callback token (15min TTL)
  discordMessageId?: string;
}

export interface ReplyOptions {
  ephemeral?: boolean;       // Discord slash only
  format?: 'plain' | 'embed';
  replyToMessageId?: string;
  metadata?: {               // Optional info for embed footer
    durationMs?: number;
    tokenCount?: number;
  };
}

export interface BotCommand {
  name: string;              // e.g. "ask"
  description: string;
  options?: BotCommandOption[];
}

export interface BotCommandOption {
  name: string;
  description: string;
  type: 'string' | 'boolean' | 'integer';
  required?: boolean;
}

export interface ChannelAdapter {
  readonly channelType: string;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Send reply (required — all adapters must implement)
  sendReply(ctx: ReplyContext, text: string, opts?: ReplyOptions): Promise<void>;

  // Slash commands (optional — only Discord implements initially)
  registerCommands?(botId: string, commands: BotCommand[]): Promise<void>;
  unregisterCommands?(botId: string): Promise<void>;
}
```

### 2. Base Adapter Class

Located in `control-plane/src/adapters/base.ts`:

```typescript
export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly channelType: string;
  protected logger: pino.Logger;

  constructor(logger: pino.Logger) {
    this.logger = logger.child({ component: `adapter-${this.channelType}` });
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendReply(ctx: ReplyContext, text: string, opts?: ReplyOptions): Promise<void>;
}
```

### 3. Directory Structure

```
control-plane/src/adapters/
├── base.ts                    # BaseChannelAdapter abstract class
├── registry.ts                # AdapterRegistry — lookup adapter by channelType
├── discord/
│   ├── index.ts               # DiscordAdapter class
│   ├── slash-commands.ts      # Command registration + InteractionCreate handler
│   └── embeds.ts              # Text → EmbedBuilder formatting
├── slack/
│   └── index.ts               # SlackAdapter (wraps existing channels/slack.ts)
└── telegram/
    └── index.ts               # TelegramAdapter (wraps existing channels/telegram.ts)
```

### 4. Discord Adapter

```typescript
class DiscordAdapter extends BaseChannelAdapter {
  readonly channelType = 'discord';

  // Consolidates:
  //   - discord/gateway-manager.ts (leader election + Gateway lifecycle)
  //   - discord/message-handler.ts (MESSAGE_CREATE processing)
  //   - channels/discord.ts (REST sendMessage)

  async start(): Promise<void> {
    // 1. Discover Discord channels from DynamoDB
    // 2. Leader election (existing logic)
    // 3. Connect Gateway client
    // 4. Register slash commands for each bot's guilds
    // 5. Listen for MessageCreate + InteractionCreate
  }

  async sendReply(ctx: ReplyContext, text: string, opts?: ReplyOptions): Promise<void> {
    if (ctx.discordInteractionToken) {
      // Slash command reply → interaction.editReply()
      await this.editInteractionReply(ctx, text, opts);
    } else {
      // Regular message reply → channel.send()
      await this.sendChannelMessage(ctx, text, opts);
    }
  }

  async registerCommands(botId: string, commands: BotCommand[]): Promise<void> {
    // PUT /applications/{appId}/guilds/{guildId}/commands
    // Guild commands (instant) not global commands (up to 1h cache)
  }
}
```

### 5. Slash Commands

#### 5.1 Default Commands

| Command | Parameters | Description | Reply Type |
|---------|-----------|-------------|------------|
| `/ask` | `prompt: string` (required), `public: boolean` (optional, default false) | Send a question to the bot | Ephemeral by default |
| `/status` | — | Show bot status, connected guilds, session info | Ephemeral |
| `/help` | — | List available commands and usage guide | Ephemeral |

#### 5.2 Registration Flow

```
Events.ClientReady
  → For each bot with Discord channel:
    → Fetch bot's guild IDs from DynamoDB channels table
    → PUT /applications/{appId}/guilds/{guildId}/commands
    → Register [/ask, /status, /help]
```

- Registration is idempotent (Discord deduplicates by command name)
- Guild commands chosen over global commands for instant availability
- On bot channel deletion, call `unregisterCommands()` to clean up

#### 5.3 Interaction Handling

```
Events.InteractionCreate
  → isChatInputCommand?
    → /ask:
      1. interaction.deferReply({ ephemeral })
      2. Build InboundMessage with groupJid = "dc:slash:{userId}"
      3. Store interactionToken in SQS payload (ReplyContext)
      4. Dispatch to SQS → AgentCore
      5. On agent response, dispatcher calls adapter.sendReply(ctx)
         → ctx has discordInteractionToken → editReply()
    → /status:
      1. Query bot info + groups from DynamoDB
      2. Reply immediately with embed (no agent invocation)
    → /help:
      1. Reply immediately with command list embed
```

#### 5.4 Interaction Token Lifecycle

- Discord interaction tokens are valid for **15 minutes**
- Token is passed through: `SqsInboundPayload.replyContext.discordInteractionToken`
- If agent takes >15 min (unlikely), fallback to channel.send() with @mention

### 6. Embed Reply Formatting

Located in `adapters/discord/embeds.ts`:

```typescript
function buildReplyEmbed(text: string, opts?: ReplyOptions): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)                    // Discord blurple
    .setDescription(text.slice(0, 4096));  // Embed limit: 4096 chars

  // Optional footer with performance info
  if (opts?.metadata) {
    const parts: string[] = [];
    if (opts.metadata.durationMs) {
      parts.push(`${(opts.metadata.durationMs / 1000).toFixed(1)}s`);
    }
    if (opts.metadata.tokenCount) {
      parts.push(`${opts.metadata.tokenCount.toLocaleString()} tokens`);
    }
    if (parts.length) embed.setFooter({ text: parts.join('  •  ') });
  }

  return embed;
}
```

**Message limits comparison:**
- `content` field: 2,000 chars → needs frequent splitting
- `embed.description`: 4,096 chars → fewer splits needed
- For replies > 4,096 chars: first chunk as embed, remaining as plain content splits

### 7. Typing Indicator

When a message is dispatched to SQS (before agent processes):

```typescript
// In DiscordAdapter, after SQS dispatch:
await channel.sendTyping();

// Discord typing indicator lasts 10 seconds
// Set interval to re-send if agent takes longer:
const typingInterval = setInterval(() => channel.sendTyping(), 9000);
// Clear on reply
```

### 8. Adapter Registry

Located in `adapters/registry.ts`:

```typescript
class AdapterRegistry {
  private adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
  }

  get(channelType: string): ChannelAdapter | undefined {
    return this.adapters.get(channelType);
  }

  async startAll(): Promise<void> {
    for (const [, adapter] of this.adapters) {
      await adapter.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const [, adapter] of this.adapters) {
      await adapter.stop();
    }
  }
}
```

Integration in `control-plane/src/index.ts`:

```typescript
const registry = new AdapterRegistry();
registry.register(new DiscordAdapter(logger));
registry.register(new SlackAdapter(logger));
registry.register(new TelegramAdapter(logger));
await registry.startAll();

// Dispatcher uses registry:
const adapter = registry.get(message.channelType);
await adapter.sendReply(replyContext, agentResponse);
```

### 9. SQS Payload Changes

Add `replyContext` to `SqsInboundPayload` (in `shared/src/types.ts`):

```typescript
export interface SqsInboundPayload {
  type: 'inbound_message';
  botId: string;
  groupJid: string;
  userId: string;
  messageId: string;
  channelType: string;
  timestamp: string;
  attachments?: Attachment[];
  // NEW: context needed for reply routing
  replyContext?: {
    discordInteractionToken?: string;
    discordChannelId?: string;
    slackResponseUrl?: string;
    // Extensible for future adapters
  };
}
```

### 10. Migration Plan

Phase 1 — Adapter abstraction (non-breaking):
1. Create `adapters/` directory structure
2. Implement `DiscordAdapter` by extracting from `discord/gateway-manager.ts` + `channels/discord.ts`
3. Implement thin `SlackAdapter` and `TelegramAdapter` wrapping existing code
4. Wire `AdapterRegistry` into index.ts and dispatcher
5. Verify existing message flow unchanged

Phase 2 — Slash Commands:
1. Add `InteractionCreate` listener in `DiscordAdapter`
2. Implement `slash-commands.ts` with /ask, /status, /help
3. Add `replyContext` to SQS payload
4. Update dispatcher to route replies through adapter
5. Test: /ask triggers agent, /status and /help reply immediately

Phase 3 — Embed replies + typing:
1. Implement `embeds.ts` formatter
2. Switch `sendReply` to use embeds by default
3. Add typing indicator on message dispatch
4. Test: all Discord replies use embed format

### 11. Files Changed (Estimated)

| File | Change |
|------|--------|
| `shared/src/types.ts` | Add `replyContext` to `SqsInboundPayload` |
| `shared/src/channel-adapter.ts` | **New** — interface definitions |
| `control-plane/src/adapters/base.ts` | **New** — abstract class |
| `control-plane/src/adapters/registry.ts` | **New** — adapter registry |
| `control-plane/src/adapters/discord/index.ts` | **New** — DiscordAdapter |
| `control-plane/src/adapters/discord/slash-commands.ts` | **New** — command registration |
| `control-plane/src/adapters/discord/embeds.ts` | **New** — embed formatting |
| `control-plane/src/adapters/slack/index.ts` | **New** — thin wrapper |
| `control-plane/src/adapters/telegram/index.ts` | **New** — thin wrapper |
| `control-plane/src/index.ts` | Wire registry, replace direct Gateway calls |
| `control-plane/src/sqs/dispatcher.ts` | Use adapter.sendReply() instead of direct channel calls |
| `control-plane/src/discord/message-handler.ts` | Move into DiscordAdapter |
| `control-plane/src/discord/gateway-manager.ts` | Move into DiscordAdapter |
| `control-plane/src/channels/discord.ts` | Deprecate, logic moves to adapter |

### 12. Not In Scope (Future P2/P3)

- Thread binding / independent thread sessions
- DM policy management (pairing/allowlist/open/disabled)
- Reaction event handling
- Interactive components (buttons/selects/modals)
- Exec approvals
- Streaming replies (DynamoDB polling or SSE)
- Voice channel support
- Multi-guild fine-grained permissions
