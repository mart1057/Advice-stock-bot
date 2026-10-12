import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelDispatcher } from '../src/notification/channels.js';
import type { NotificationChannel, OutboundMessage } from '../src/notification/channel.types.js';
import { NotificationService } from '../src/notification/notification.service.js';

const message: OutboundMessage = {
  flex: { type: 'flex', altText: 'test', contents: { type: 'bubble' } } as never,
  text: 'test',
};

const channel = (
  name: string,
  { configured = true, success = true }: { configured?: boolean; success?: boolean } = {},
): NotificationChannel & { send: ReturnType<typeof vi.fn> } => ({
  name,
  isConfigured: () => configured,
  send: vi.fn().mockResolvedValue({
    channel: name,
    success,
    messageId: success ? `${name}-1` : null,
    skipped: false,
    error: success ? undefined : `${name} failed`,
  }),
});

describe('ChannelDispatcher', () => {
  it('excludes Telegram from system notices while preserving other channels', async () => {
    const line = channel('line');
    const telegram = channel('telegram');
    const discord = channel('discord');
    const result = await new ChannelDispatcher([line, telegram, discord]).push({
      ...message,
      kind: 'system',
    });

    expect(telegram.send).not.toHaveBeenCalled();
    expect(line.send).toHaveBeenCalledTimes(1);
    expect(discord.send).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('silently skips system notices when only Telegram is configured', async () => {
    const telegram = channel('telegram');
    const result = await new ChannelDispatcher([telegram]).push({ ...message, kind: 'system' });
    expect(telegram.send).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, messageId: null, results: [] });
  });

  it('fans one message out to every configured channel', async () => {
    const line = channel('line');
    const telegram = channel('telegram');
    const result = await new ChannelDispatcher([line, telegram]).push(message);

    expect(line.send).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('skips channels that are not configured', async () => {
    const line = channel('line', { configured: false });
    const telegram = channel('telegram');
    await new ChannelDispatcher([line, telegram]).push(message);

    expect(line.send).not.toHaveBeenCalled();
    expect(telegram.send).toHaveBeenCalledTimes(1);
  });

  /// The whole point of the multi-channel work: LINE running out of quota
  /// must not silence the bot when Telegram still works.
  it('counts the alert as delivered when one channel succeeds and another fails', async () => {
    const line = channel('line', { success: false });
    const telegram = channel('telegram');
    const result = await new ChannelDispatcher([line, telegram]).push(message);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('telegram-1');
    expect(result.error).toContain('line: line failed');
  });

  it('fails when every channel fails', async () => {
    const result = await new ChannelDispatcher([
      channel('line', { success: false }),
      channel('telegram', { success: false }),
    ]).push(message);

    expect(result.success).toBe(false);
  });

  it('fails cleanly when nothing is configured', async () => {
    const result = await new ChannelDispatcher([channel('line', { configured: false })]).push(
      message,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No notification channel configured');
  });

  it('survives a channel that throws', async () => {
    const exploding: NotificationChannel = {
      name: 'boom',
      isConfigured: () => true,
      send: vi.fn().mockRejectedValue(new Error('network down')),
    };
    const telegram = channel('telegram');
    const result = await new ChannelDispatcher([exploding, telegram]).push(message);

    expect(result.success).toBe(true);
    expect(result.error).toContain('network down');
  });
});

const stubSnapshot = () =>
  Promise.resolve({
    total: 32,
    available: 2,
    unavailable: 30,
    unknown: 0,
    lastCheckedAt: new Date('2026-09-17T16:30:15.000Z'),
    inStock: [
      { colorTh: 'เบอร์กันดี', storage: '256GB', storeName: 'Advice Online Store' },
      { colorTh: 'ดำ', storage: '1TB', storeName: 'Advice Online Store' },
    ],
  });

describe('system alert throttle', () => {
  const dispatcher = () => ({ push: vi.fn().mockResolvedValue({ success: true, messageId: 'm1' }) });
  const repo = () => ({ logNotification: vi.fn().mockResolvedValue(undefined) });

  const cooldown = {
    cooldownMs: 120_000,
    until: new Date('2026-09-20T10:00:00.000Z'),
    consecutiveFailures: 2,
    escalated: false,
  };

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('does not send rate-limit or recovery notices to Telegram', async () => {
    const telegram = channel('telegram');
    const channels = new ChannelDispatcher([telegram]);
    // Separate instances ensure the throttle does not hide either notice.
    await new NotificationService(channels, repo() as never, stubSnapshot).notifyRateLimited(cooldown);
    await new NotificationService(channels, repo() as never, stubSnapshot).notifyRecovered();
    expect(telegram.send).not.toHaveBeenCalled();
  });

  /// Reproduces the quota burn: Advice flapping made the guard ping-pong
  /// cooldown -> recover -> cooldown, one message per swing.
  it('sends only the first notice within the throttle window', async () => {
    const channels = dispatcher();
    const service = new NotificationService(channels as never, repo() as never, stubSnapshot);

    await service.notifyRateLimited(cooldown);
    await service.notifyRecovered();
    await service.notifyRateLimited(cooldown);
    await service.notifyRecovered();

    expect(channels.push).toHaveBeenCalledTimes(1);
  });

  it('reports how many notices were swallowed once the window passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));

    const channels = dispatcher();
    const service = new NotificationService(channels as never, repo() as never, stubSnapshot);

    await service.notifyRateLimited(cooldown);
    await service.notifyRecovered();
    await service.notifyRecovered();

    vi.setSystemTime(new Date('2026-09-20T10:31:00.000Z'));
    await service.notifyRecovered();

    expect(channels.push).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(channels.push.mock.calls[1])).toContain('แจ้งเตือนที่ข้ามไป');
    vi.useRealTimers();
  });

  /// A dead channel must not be retried on every guard swing forever - the
  /// window is keyed to the attempt, not to the outcome.
  it('throttles attempts too, so a dead channel is not hammered', async () => {
    const channels = { push: vi.fn().mockResolvedValue({ success: false, error: 'no channel' }) };
    const service = new NotificationService(channels as never, repo() as never, stubSnapshot);

    await service.notifyRateLimited(cooldown);
    await service.notifyRecovered();
    await service.notifyRateLimited(cooldown);

    expect(channels.push).toHaveBeenCalledTimes(1);
  });

  /// Notices swallowed while the channel was dead still get reported once
  /// something can actually deliver again.
  it('keeps the suppressed count across a failed attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));

    const push = vi.fn().mockResolvedValue({ success: false, error: 'no channel' });
    const service = new NotificationService({ push } as never, repo() as never, stubSnapshot);

    await service.notifyRateLimited(cooldown); // attempted, failed
    await service.notifyRecovered(); // suppressed -> count 1

    vi.setSystemTime(new Date('2026-09-20T10:31:00.000Z'));
    push.mockResolvedValue({ success: true, messageId: 'm1' });
    await service.notifyRecovered();

    expect(JSON.stringify(push.mock.calls[1])).toContain('แจ้งเตือนที่ข้ามไป');
    vi.useRealTimers();
  });

  it('never throttles stock alerts', async () => {
    const channels = dispatcher();
    const service = new NotificationService(channels as never, repo() as never, stubSnapshot, async () => {});

    const transition = {
      stockId: 's1',
      previousStatus: 'UNAVAILABLE' as const,
      currentStatus: 'AVAILABLE' as const,
      stock: {
        model: 'iPhone 18 Pro Max',
        color: 'Black',
        colorTh: 'ดำ',
        storage: '256GB',
        partNumber: 'MJXQ4ZP/A',
        basePart: 'MJXQ4',
        priceTHB: 52900,
        storeName: 'Advice Online Store',
        storeCode: 'R733',
        status: 'AVAILABLE' as const,
        available: true,
        quote: 'พร้อมจำหน่าย',
        checkedAt: new Date('2026-09-20T10:00:00.000Z'),
      },
    };
    const result = {
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 1,
      checked: 1,
      available: 1,
      unavailable: 0,
      unknown: 0,
      transitions: [transition],
      firstRun: false,
      errors: [],
      rateLimited: false,
    };

    await service.notifyRateLimited(cooldown);
    await service.notify(result as never);
    await service.notify(result as never);

    // 1 system notice + 2 copies of each of the 2 stock alerts, none throttled.
    expect(channels.push).toHaveBeenCalledTimes(5);
  });
});

describe('LINE monthly quota handling', () => {
  const quotaBody = '{"message":"You have reached your monthly limit."}';

  /// The suite runs with LINE_DRY_RUN=true, which short-circuits push() before
  /// it ever reaches fetch. These tests need the real path, so they re-import
  /// the module with a fresh environment.
  const freshLine = async (status: number, body: string) => {
    vi.resetModules();
    vi.stubEnv('LINE_DRY_RUN', 'false');
    vi.stubEnv('RETRY_BASE_DELAY_MS', '50');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        text: async () => body,
        headers: { get: () => null },
      }),
    );
    const mod = await import('../src/notification/line.service.js');
    return new mod.LineNotificationService();
  };

  const flex = { type: 'flex', altText: 'x', contents: { type: 'bubble' } } as never;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('does not retry a 429 that means the monthly quota is gone', async () => {
    const line = await freshLine(429, quotaBody);
    await line.push(flex);

    // One call, not MAX_RETRIES + 1: the quota will not come back in 500ms.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('marks itself unavailable after the quota 429', async () => {
    const line = await freshLine(429, quotaBody);

    expect(line.isAvailable()).toBe(true);
    await line.push(flex);
    expect(line.isAvailable()).toBe(false);
  });

  it('becomes available again once the quota cooldown elapses', async () => {
    const line = await freshLine(429, quotaBody);
    await line.push(flex);

    expect(line.isAvailable()).toBe(false);
    // 6h + a minute later.
    expect(line.isAvailable(Date.now() + 6 * 60 * 60 * 1000 + 60_000)).toBe(true);
  });

  it('still retries an ordinary short-term 429', async () => {
    const line = await freshLine(429, '{"message":"Too Many Requests"}');
    await line.push(flex);

    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(1);
    expect(line.isAvailable()).toBe(true);
  });

  it('a quota-dead LINE stops the dispatcher from calling it', async () => {
    const line: NotificationChannel & { send: ReturnType<typeof vi.fn> } = {
      name: 'line',
      isConfigured: () => true,
      isAvailable: () => false,
      send: vi.fn(),
    };
    const result = await new ChannelDispatcher([line]).push(message);

    expect(line.send).not.toHaveBeenCalled();
    expect(result.error).toContain('Every configured channel is unavailable');
  });
});
