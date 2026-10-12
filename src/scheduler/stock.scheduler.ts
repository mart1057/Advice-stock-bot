import { hostname } from 'node:os';
import cron, { type ScheduledTask } from 'node-cron';
import { isRateLimitError } from '../advice/advice.types.js';
import { env } from '../config/env.js';
import { notificationService, type NotificationService } from '../notification/notification.service.js';
import { stockRepository, type StockRepository } from '../stock/stock.repository.js';
import { stockService, type StockService } from '../stock/stock.service.js';
import { logger } from '../utils/logger.js';
import { RateLimitGuard } from './rate-limit.guard.js';

const LOCK_NAME = 'stock-check';
const OWNER = `${hostname()}:${process.pid}`;

/**
 * Runs the stock check on a schedule with a hard no-overlap guarantee.
 *
 * Two layers:
 *   1. `isRunning` in-process guard - a tick that arrives while the previous
 *      run is still going is SKIPPED, never queued.
 *   2. Optional DB lock (`DISTRIBUTED_LOCK_ENABLED`) with a TTL, for when more
 *      than one bot instance shares a database.
 *
 * On top of that an adaptive cooldown (`RateLimitGuard`) pauses polling when
 * Advice starts pushing back, so the bot never keeps hammering a blocked
 * endpoint at full rate.
 *
 * In interval mode the next run is scheduled `interval` seconds AFTER the
 * previous one finishes, so a 40s run under a 30s interval simply paces
 * itself instead of piling up.
 */
export class StockScheduler {
  private isRunning = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private cronTask: ScheduledTask | null = null;
  private skippedTicks = 0;

  constructor(
    private readonly stocks: StockService = stockService,
    private readonly notifications: NotificationService = notificationService,
    private readonly repository: StockRepository = stockRepository,
    private readonly rateLimit: RateLimitGuard = new RateLimitGuard(),
  ) {}

  async start(): Promise<void> {
    this.stopped = false;

    if (env.STOCK_CHECK_CRON.length > 0) {
      if (!cron.validate(env.STOCK_CHECK_CRON)) {
        throw new Error(`Invalid STOCK_CHECK_CRON expression: "${env.STOCK_CHECK_CRON}"`);
      }
      logger.info(`Scheduler mode: cron "${env.STOCK_CHECK_CRON}"`);
      this.cronTask = cron.schedule(env.STOCK_CHECK_CRON, () => {
        void this.tick();
      });
    } else {
      logger.info(`Scheduler mode: fixed delay ${env.STOCK_CHECK_INTERVAL_SECONDS}s`);
    }

    if (env.RUN_ON_STARTUP) {
      await this.tick();
    }

    if (env.STOCK_CHECK_CRON.length === 0) this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cronTask?.stop();
    this.cronTask = null;
    await this.repository.releaseLock(LOCK_NAME, OWNER).catch(() => undefined);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, env.STOCK_CHECK_INTERVAL_SECONDS * 1000);
  }

  private async enterCooldown(reason?: string): Promise<void> {
    const entry = this.rateLimit.recordRateLimited();
    if (!entry) {
      logger.warn(
        'Advice pushed back - tolerating one failure before cooling down',
        reason ?? 'no detail',
      );
      return;
    }

    logger.warn(
      `Advice rate limit - pausing checks for ${Math.round(entry.cooldownMs / 1000)}s`,
      `level=${entry.level} consecutive=${entry.consecutiveFailures}${entry.escalated ? ' (escalated)' : ''}`,
    );

    // Alert on the first entry and on every escalation, never on every tick.
    await this.notifications
      .notifyRateLimited({
        cooldownMs: entry.cooldownMs,
        until: entry.until,
        consecutiveFailures: entry.consecutiveFailures,
        escalated: entry.escalated,
      })
      .catch((error: unknown) => logger.error('Rate-limit alert failed', error));
  }

  private async markHealthy(): Promise<void> {
    if (!this.rateLimit.recordSuccess()) return;

    logger.info('Advice responded normally - rate-limit cooldown cleared');
    await this.notifications
      .notifyRecovered()
      .catch((error: unknown) => logger.error('Recovery alert failed', error));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    if (this.isRunning) {
      this.skippedTicks += 1;
      logger.warn(
        'Previous stock check still running - tick skipped',
        `skipped=${this.skippedTicks}`,
      );
      return;
    }

    const gate = this.rateLimit.check();
    if (gate.skip) {
      logger.warn(
        'Rate-limit cooldown active - tick skipped',
        `resumes in ${Math.ceil(gate.remainingMs / 1000)}s`,
      );
      return;
    }

    let lockHeld = false;
    this.isRunning = true;

    try {
      if (env.DISTRIBUTED_LOCK_ENABLED) {
        lockHeld = await this.repository.acquireLock(LOCK_NAME, OWNER, env.LOCK_TTL_SECONDS);
        if (!lockHeld) {
          logger.warn('Another instance holds the stock-check lock - tick skipped');
          return;
        }
      }

      const result = await this.stocks.runCheck();
      await this.notifications.notify(result);

      if (result.rateLimited) {
        await this.enterCooldown(result.errors[0]);
      } else {
        await this.markHealthy();
      }
    } catch (error) {
      // A failed cycle must never kill the scheduler.
      logger.error('Stock check cycle failed', error);
      if (isRateLimitError(error)) {
        await this.enterCooldown(error instanceof Error ? error.message : undefined);
      } else {
        this.rateLimit.recordFailure();
      }
    } finally {
      this.isRunning = false;
      if (lockHeld) await this.repository.releaseLock(LOCK_NAME, OWNER).catch(() => undefined);
    }
  }
}

export const stockScheduler = new StockScheduler();
