import { env } from '../config/env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

const useColor = process.stdout.isTTY === true && env.NODE_ENV !== 'production';

const clock = (date = new Date()): string =>
  date.toLocaleTimeString('en-GB', { hour12: false, timeZone: process.env.TZ ?? 'Asia/Bangkok' });

const formatMeta = (meta: unknown): string => {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.name}: ${meta.message}`;
  if (typeof meta === 'string') return ` ${meta}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' [unserializable meta]';
  }
};

const emit = (level: Level, message: string, meta?: unknown): void => {
  if (ORDER[level] < ORDER[env.LOG_LEVEL]) return;
  const tag = level.toUpperCase().padEnd(5);
  const head = `[${clock()}] ${tag}`;
  const line = `${useColor ? COLOR[level] + head + RESET : head} ${message}${formatMeta(meta)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export const logger = {
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  warn: (message: string, meta?: unknown) => emit('warn', message, meta),
  error: (message: string, meta?: unknown) => emit('error', message, meta),
  /// Plain stdout line, used for the startup banner.
  raw: (message: string) => console.log(message),
};
