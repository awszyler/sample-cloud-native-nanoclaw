// Channel Adapter — Base abstract class
// All channel adapters extend this to get consistent logging and structure.

import type pino from 'pino';
import type {
  ChannelAdapter,
  ReplyContext,
  ReplyOptions,
  BotCommand,
} from '@clawbot/shared/channel-adapter';

export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly channelType: string;
  protected logger: pino.Logger;

  constructor(parentLogger: pino.Logger) {
    // child() is called lazily so channelType is set by the subclass first
    this.logger = parentLogger;
  }

  protected init(): void {
    this.logger = this.logger.child({ adapter: this.channelType });
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendReply(
    ctx: ReplyContext,
    text: string,
    opts?: ReplyOptions,
  ): Promise<void>;

  // Optional — subclasses override if they support commands
  registerCommands?(botId: string, commands: BotCommand[]): Promise<void>;
  unregisterCommands?(botId: string): Promise<void>;
}
