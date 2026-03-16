// Telegram Channel Adapter
// Thin wrapper around the existing Telegram channel client.
// Telegram uses webhooks for inbound — start/stop are no-ops.

import { BaseChannelAdapter } from '../base.js';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import { sendMessage } from '../../channels/telegram.js';
import { getChannelsByBot } from '../../services/dynamo.js';
import { getChannelCredentials } from '../../services/cached-lookups.js';

export class TelegramAdapter extends BaseChannelAdapter {
  readonly channelType = 'telegram';

  constructor(parentLogger: import('pino').Logger) {
    super(parentLogger);
    this.init();
  }

  async start(): Promise<void> {
    // Telegram uses webhook-based ingestion — no gateway to connect
  }

  async stop(): Promise<void> {
    // Nothing to tear down
  }

  async sendReply(
    ctx: ReplyContext,
    text: string,
    _opts?: ReplyOptions,
  ): Promise<void> {
    try {
      // Load channel config for this bot
      const channels = await getChannelsByBot(ctx.botId);
      const channel = channels.find((ch) => ch.channelType === 'telegram');
      if (!channel) {
        this.logger.warn(
          { botId: ctx.botId },
          'No Telegram channel configured for bot',
        );
        return;
      }

      // Load credentials from Secrets Manager (cached)
      const creds = await getChannelCredentials(channel.credentialSecretArn);

      // Extract Telegram chat ID from groupJid (format: "tg:123456")
      const chatId = ctx.groupJid.split(':')[1];
      if (!chatId) {
        this.logger.error(
          { groupJid: ctx.groupJid },
          'Could not extract chatId from groupJid',
        );
        return;
      }

      await sendMessage(creds.botToken, chatId, text);

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid },
        'Telegram reply sent',
      );
    } catch (err) {
      this.logger.error(
        { err, botId: ctx.botId, groupJid: ctx.groupJid },
        'Failed to send Telegram reply',
      );
    }
  }
}
