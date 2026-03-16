// Adapter Registry — Central lookup for channel adapters
// Used by the dispatcher to route replies to the correct platform.

import type { ChannelAdapter } from '@clawbot/shared/channel-adapter';
import type pino from 'pino';

export class AdapterRegistry {
  private adapters = new Map<string, ChannelAdapter>();
  private logger: pino.Logger;

  constructor(logger: pino.Logger) {
    this.logger = logger.child({ component: 'adapter-registry' });
  }

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
    this.logger.info({ channelType: adapter.channelType }, 'Adapter registered');
  }

  get(channelType: string): ChannelAdapter | undefined {
    return this.adapters.get(channelType);
  }

  async startAll(): Promise<void> {
    for (const [type, adapter] of this.adapters) {
      try {
        await adapter.start();
        this.logger.info({ channelType: type }, 'Adapter started');
      } catch (err) {
        this.logger.error({ err, channelType: type }, 'Failed to start adapter');
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [type, adapter] of this.adapters) {
      try {
        await adapter.stop();
        this.logger.info({ channelType: type }, 'Adapter stopped');
      } catch (err) {
        this.logger.error({ err, channelType: type }, 'Failed to stop adapter');
      }
    }
  }
}

// Singleton registry — initialized by index.ts, accessed by dispatcher
let _registry: AdapterRegistry | null = null;

export function initRegistry(logger: pino.Logger): AdapterRegistry {
  _registry = new AdapterRegistry(logger);
  return _registry;
}

export function getRegistry(): AdapterRegistry {
  if (!_registry) throw new Error('AdapterRegistry not initialized');
  return _registry;
}
