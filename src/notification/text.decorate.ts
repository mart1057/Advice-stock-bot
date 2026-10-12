/**
 * Discord (and Telegram) group consecutive messages from the same sender
 * tightly together, so two alerts arriving minutes apart read as one wall of
 * text. A divider on the first line gives each message a visible top edge.
 *
 * Plain Unicode on purpose: the same string has to look right in Discord,
 * in Telegram and in a terminal log, so no channel-specific Markdown.
 */
export const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━━';

/// Prefixes a message with the divider, skipping it if one is already there.
export const withDivider = (text: string): string =>
  text.startsWith(DIVIDER) ? text : `${DIVIDER}\n${text}`;
