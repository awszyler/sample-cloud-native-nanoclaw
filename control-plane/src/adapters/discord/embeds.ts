// Discord Embed Formatting
// Converts plain text replies into Discord Embed format for richer display.

import { EmbedBuilder } from 'discord.js';
import type { ReplyOptions } from '@clawbot/shared/channel-adapter';

const DISCORD_BLURPLE = 0x5865f2;
const EMBED_DESC_LIMIT = 4096;
const CONTENT_LIMIT = 2000;

/**
 * Build a Discord embed from reply text.
 * Embed description supports 4096 chars (vs 2000 for content field).
 */
export function buildReplyEmbed(
  text: string,
  opts?: ReplyOptions,
): EmbedBuilder {
  const desc = text.slice(0, EMBED_DESC_LIMIT) || '\u200b'; // zero-width space if empty
  const embed = new EmbedBuilder()
    .setColor(DISCORD_BLURPLE)
    .setDescription(desc);

  if (opts?.metadata) {
    const parts: string[] = [];
    if (opts.metadata.durationMs != null) {
      parts.push(`${(opts.metadata.durationMs / 1000).toFixed(1)}s`);
    }
    if (opts.metadata.tokenCount != null) {
      parts.push(`${opts.metadata.tokenCount.toLocaleString()} tokens`);
    }
    if (parts.length) embed.setFooter({ text: parts.join('  \u2022  ') });
  }

  return embed;
}

/**
 * Split a long reply into embed (first chunk) + plain text (overflow).
 * Returns { embeds, contentChunks } ready for Discord API calls.
 */
export function formatDiscordReply(
  text: string,
  opts?: ReplyOptions,
): { embed: EmbedBuilder; overflow: string[] } {
  const embed = buildReplyEmbed(text, opts);
  const overflow: string[] = [];

  if (text.length > EMBED_DESC_LIMIT) {
    let remaining = text.slice(EMBED_DESC_LIMIT);
    while (remaining.length > 0) {
      if (remaining.length <= CONTENT_LIMIT) {
        overflow.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf('\n', CONTENT_LIMIT);
      if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', CONTENT_LIMIT);
      if (splitIdx <= 0) splitIdx = CONTENT_LIMIT;
      overflow.push(remaining.substring(0, splitIdx));
      remaining = remaining.substring(splitIdx).trimStart();
    }
  }

  return { embed, overflow };
}
