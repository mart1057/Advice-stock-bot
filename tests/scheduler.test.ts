import { describe, expect, it, vi } from 'vitest';
import { AdviceRequestError } from '../src/advice/advice.types.js';
import { RateLimitGuard } from '../src/scheduler/rate-limit.guard.js';
import { StockScheduler } from '../src/scheduler/stock.scheduler.js';
import type { StockCheckResult } from '../src/stock/stock.types.js';

const emptyResult = (): StockCheckResult => ({
  startedAt: new Date(),
  finishedAt: new Date(),
  durationMs: 0,
  checked: 0,
  available: 0,
  unavailable: 0,
  unknown: 0,
  transitions: [],
  firstRun: false,
  errors: [],
  rateLimited: false,
});

const tickOf = (scheduler: StockScheduler): (() => Promise<void>) =>
  (scheduler as unknown as { tick: () => Promise<void> }).tick.bind(scheduler);

describe('overlap protection', () => {
  it('skips a tick that arrives while the previous run is still going', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const stocks = {
      runCheck: vi.fn().mockImplementation(async () => {
        await gate;
        return emptyResult();
      }),
    };
    const notifications = { notify: vi.fn().mockResolvedValue(undefined) };
    const repository = { acquireLock: vi.fn(), releaseLock: vi.fn() };

    const scheduler = new StockScheduler(
      stocks as never,
      notifications as never,
      repository as never,
    );
    const tick = tickOf(scheduler);

    const first = tick(); // long-running
    await tick(); // must be skipped, not queued
    await tick(); // skipped too

    expect(stocks.runCheck).toHaveBeenCalledTimes(1);

    release();
    await first;

    // Once the slow run finishes, the next tick is allowed through.
    await tick();
    expect(stocks.runCheck).toHaveBeenCalledTimes(2);
  });

  it('keeps running after a failed cycle', async () => {
    const stocks = {
      runCheck: vi
        .fn()
        .mockRejectedValueOnce(new Error('Advice request failed status=500'))
        .mockResolvedValue(emptyResult()),
    };
    const notifications = { notify: vi.fn().mockResolvedValue(undefined) };
    const repository = { acquireLock: vi.fn(), releaseLock: vi.fn() };

    const scheduler = new StockScheduler(
      stocks as never,
      notifications as never,
      repository as never,
    );
    const tick = tickOf(scheduler);

    await expect(tick()).resolves.toBeUndefined();
    await tick();

    expect(stocks.runCheck).toHaveBeenCalledTimes(2);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });
});


describe('adaptive cooldown in the scheduler', () => {
  const build = () => {
    const stocks = { runCheck: vi.fn() };
    const notifications = {
      notify: vi.fn().mockResolvedValue(undefined),
      notifyRateLimited: vi.fn().mockResolvedValue(undefined),
      notifyRecovered: vi.fn().mockResolvedValue(undefined),
    };
    const repository = { acquireLock: vi.fn(), releaseLock: vi.fn() };
    const guard = new RateLimitGuard({
      triggerFailures: 2,
      baseCooldownMs: 120_000,
      maxCooldownMs: 600_000,
    });
    const scheduler = new StockScheduler(
      stocks as never,
      notifications as never,
      repository as never,
      guard,
    );
    return { stocks, notifications, scheduler, tick: tickOf(scheduler) };
  };

  it('stops polling and alerts LINE once after repeated push-back', async () => {
    const { stocks, notifications, tick } = build();
    stocks.runCheck.mockResolvedValue({ ...emptyResult(), rateLimited: true, errors: ['541'] });

    await tick(); // first push-back: tolerated
    expect(notifications.notifyRateLimited).not.toHaveBeenCalled();

    await tick(); // second: cooldown starts + one alert
    expect(notifications.notifyRateLimited).toHaveBeenCalledTimes(1);

    await tick(); // inside the cooldown window -> no request at all
    await tick();
    expect(stocks.runCheck).toHaveBeenCalledTimes(2);
    expect(notifications.notifyRateLimited).toHaveBeenCalledTimes(1);
  });

  it('cools down when the whole cycle throws a 429', async () => {
    const { stocks, notifications, tick } = build();
    stocks.runCheck.mockRejectedValue(new AdviceRequestError('rate limited', 429));

    await tick();
    await tick();
    expect(notifications.notifyRateLimited).toHaveBeenCalledTimes(1);

    await tick();
    expect(stocks.runCheck).toHaveBeenCalledTimes(2);
  });

  it('resumes and alerts recovery on the first clean cycle', async () => {
    const { stocks, notifications, tick } = build();
    stocks.runCheck.mockResolvedValue({ ...emptyResult(), rateLimited: true });

    await tick();
    await tick();

    // Pretend the cooldown elapsed.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
    stocks.runCheck.mockResolvedValue(emptyResult());

    await tick();
    expect(notifications.notifyRecovered).toHaveBeenCalledTimes(1);

    await tick();
    expect(notifications.notifyRecovered).toHaveBeenCalledTimes(1); // not repeated
    vi.restoreAllMocks();
  });
});
