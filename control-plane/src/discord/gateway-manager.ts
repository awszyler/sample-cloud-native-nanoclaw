// Discord Gateway Manager
// Manages discord.js Client lifecycle with DynamoDB-based leader election.
// Only the leader instance connects to the Discord Gateway; the standby
// instance polls the lock and takes over if the leader's TTL expires.

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message as DjsMessage,
} from 'discord.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type pino from 'pino';
import { config } from '../config.js';
import { getChannelsByBot } from '../services/dynamo.js';
import { handleDiscordMessage } from './message-handler.js';
import type { ChannelConfig } from '@clawbot/shared';

// ── Constants ──────────────────────────────────────────────────────────────

const LOCK_TABLE = config.tables.sessions;
const LOCK_PK = '__system__';
const LOCK_SK = 'discord-gateway-leader';
const LOCK_TTL_S = 60;
const RENEW_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 30_000;

// Generate a unique ID for this ECS task instance
const INSTANCE_ID =
  process.env.ECS_TASK_ID ||
  `local-${process.pid}-${Date.now().toString(36)}`;

// ── DynamoDB + Secrets clients ─────────────────────────────────────────────

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: config.region }),
);
const secrets = new SecretsManagerClient({ region: config.region });

// ── State ──────────────────────────────────────────────────────────────────

let logger: pino.Logger;
let isLeader = false;
let client: Client | null = null;
let renewTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let stopped = false;

// Map of botId -> { channel config, bot discord ID }
interface BotGatewayInfo {
  channel: ChannelConfig;
  botDiscordId: string;
  botToken: string;
}
let activeBots: Map<string, BotGatewayInfo> = new Map();

// ── Public API ─────────────────────────────────────────────────────────────

export async function startDiscordGateway(
  parentLogger: pino.Logger,
): Promise<void> {
  logger = parentLogger.child({ component: 'discord-gateway' });
  stopped = false;

  // Discover Discord channels across all bots
  const discordChannels = await discoverDiscordChannels();
  if (discordChannels.length === 0) {
    logger.info('No Discord channels configured, Gateway disabled');
    return;
  }

  logger.info(
    { channelCount: discordChannels.length },
    'Discord channels found, starting leader election',
  );

  // Try to become leader
  const acquired = await tryAcquireLock();
  if (acquired) {
    await becomeLeader(discordChannels);
  } else {
    logger.info('Another instance is leader, entering standby');
    startStandbyPoll(discordChannels);
  }
}

export async function stopDiscordGateway(): Promise<void> {
  stopped = true;

  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (client) {
    client.destroy();
    client = null;
    logger?.info('Discord Gateway client destroyed');
  }

  if (isLeader) {
    await releaseLock();
    isLeader = false;
  }
}

// ── Leader Election ────────────────────────────────────────────────────────

async function tryAcquireLock(): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(
      new PutCommand({
        TableName: LOCK_TABLE,
        Item: {
          pk: LOCK_PK,
          sk: LOCK_SK,
          leaderId: INSTANCE_ID,
          expiresAt: now + LOCK_TTL_S,
        },
        // Acquire only if record doesn't exist or has expired
        ConditionExpression:
          'attribute_not_exists(pk) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': now },
      }),
    );
    logger.info({ instanceId: INSTANCE_ID }, 'Leader lock acquired');
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return false;
    }
    logger.error(err, 'Failed to acquire leader lock');
    return false;
  }
}

async function renewLock(): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(
      new PutCommand({
        TableName: LOCK_TABLE,
        Item: {
          pk: LOCK_PK,
          sk: LOCK_SK,
          leaderId: INSTANCE_ID,
          expiresAt: now + LOCK_TTL_S,
        },
        ConditionExpression: 'leaderId = :me',
        ExpressionAttributeValues: { ':me': INSTANCE_ID },
      }),
    );
    return true;
  } catch {
    logger.warn('Failed to renew leader lock, stepping down');
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: LOCK_TABLE,
        Key: { pk: LOCK_PK, sk: LOCK_SK },
        ConditionExpression: 'leaderId = :me',
        ExpressionAttributeValues: { ':me': INSTANCE_ID },
      }),
    );
    logger.info('Leader lock released');
  } catch {
    // Lock may have already expired or been taken by another instance
  }
}

async function isLockExpired(): Promise<boolean> {
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: LOCK_TABLE,
        Key: { pk: LOCK_PK, sk: LOCK_SK },
      }),
    );
    if (!res.Item) return true;
    return (res.Item.expiresAt as number) < Math.floor(Date.now() / 1000);
  } catch {
    return true;
  }
}

// ── Leader Lifecycle ───────────────────────────────────────────────────────

async function becomeLeader(
  discordChannels: ChannelConfig[],
): Promise<void> {
  isLeader = true;

  // Load credentials for each Discord channel
  activeBots = new Map();
  for (const ch of discordChannels) {
    try {
      const creds = await loadCredentials(ch.credentialSecretArn);
      activeBots.set(ch.botId, {
        channel: ch,
        botDiscordId: ch.channelId,
        botToken: creds.botToken,
      });
    } catch (err) {
      logger.error(
        { err, botId: ch.botId },
        'Failed to load Discord credentials',
      );
    }
  }

  if (activeBots.size === 0) {
    logger.warn('No valid Discord bot tokens found, staying leader but idle');
    startRenewLoop();
    return;
  }

  // For now, connect with the first bot's token.
  // Multi-bot support (multiple Client instances) can be added later.
  const firstBot = activeBots.values().next().value!;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
    ],
  });

  client.on(Events.ClientReady, (c) => {
    logger.info(
      { tag: c.user.tag, userId: c.user.id, guilds: c.guilds.cache.size },
      'Discord Gateway connected',
    );
    // Update botDiscordId to the actual bot user ID (may differ from application ID)
    for (const [, info] of activeBots) {
      info.botDiscordId = c.user.id;
    }
  });

  client.on(Events.MessageCreate, (message: DjsMessage) => {
    logger.info(
      {
        author: message.author.tag,
        authorId: message.author.id,
        isBot: message.author.bot,
        channelId: message.channelId,
        contentLength: message.content.length,
        guildId: message.guildId,
      },
      'Discord MessageCreate received',
    );

    // Find which bot this message belongs to based on the logged-in client
    const botInfo = findBotForMessage(message);
    if (!botInfo) {
      logger.warn('No bot info found for message, skipping');
      return;
    }

    handleDiscordMessage({
      message,
      botId: botInfo.channel.botId,
      botDiscordId: botInfo.botDiscordId,
      logger,
    }).catch((err) => {
      logger.error(
        { err, messageId: message.id },
        'Error handling Discord message',
      );
    });
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, 'Discord client error');
  });

  try {
    await client.login(firstBot.botToken);
  } catch (err) {
    logger.error(err, 'Failed to login to Discord Gateway');
    isLeader = false;
    await releaseLock();
    return;
  }

  startRenewLoop();
}

function findBotForMessage(message: DjsMessage): BotGatewayInfo | undefined {
  // With a single Client, all messages go to the first bot.
  // For multi-bot: match message.client.user.id against activeBots.
  for (const [, info] of activeBots) {
    if (client?.user?.id === info.botDiscordId) return info;
  }
  // Fallback: return first bot
  return activeBots.values().next().value;
}

function startRenewLoop(): void {
  renewTimer = setInterval(async () => {
    if (stopped) return;
    const ok = await renewLock();
    if (!ok) {
      // Lost leadership — disconnect
      logger.warn('Lost leader lock, disconnecting Gateway');
      if (client) {
        client.destroy();
        client = null;
      }
      isLeader = false;
      // Re-discover and enter standby
      const channels = await discoverDiscordChannels();
      if (channels.length > 0 && !stopped) {
        startStandbyPoll(channels);
      }
    }
  }, RENEW_INTERVAL_MS);
}

// ── Standby ────────────────────────────────────────────────────────────────

function startStandbyPoll(discordChannels: ChannelConfig[]): void {
  pollTimer = setInterval(async () => {
    if (stopped) return;
    const expired = await isLockExpired();
    if (expired) {
      logger.info('Leader lock expired, attempting takeover');
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      const acquired = await tryAcquireLock();
      if (acquired) {
        // Re-discover channels in case they changed
        const freshChannels = await discoverDiscordChannels();
        await becomeLeader(freshChannels);
      } else {
        // Another instance beat us, go back to polling
        startStandbyPoll(discordChannels);
      }
    }
  }, POLL_INTERVAL_MS);
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function discoverDiscordChannels(): Promise<ChannelConfig[]> {
  // Scan all bots' channels for discord type.
  // We query each bot's channels. For efficiency we use the DynamoDB scan
  // on the channels table filtered by channelType.
  const { DynamoDBClient: DDBClient } = await import(
    '@aws-sdk/client-dynamodb'
  );
  const { DynamoDBDocumentClient: DDBDocClient, ScanCommand } = await import(
    '@aws-sdk/lib-dynamodb'
  );
  const scanDdb = DDBDocClient.from(new DDBClient({ region: config.region }));

  const result = await scanDdb.send(
    new ScanCommand({
      TableName: config.tables.channels,
      FilterExpression: 'channelType = :ct',
      ExpressionAttributeValues: { ':ct': 'discord' },
    }),
  );

  return (result.Items || []) as ChannelConfig[];
}

async function loadCredentials(
  secretArn: string,
): Promise<Record<string, string>> {
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  return JSON.parse(res.SecretString || '{}');
}
