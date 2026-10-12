import { pruneHistory } from '../database/history.retention.js';
import { logger } from '../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class HistoryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;

  constructor(private readonly cleanup: typeof pruneHistory = pruneHistory) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Give startup and the initial stock check a head start.
    this.schedule(60_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.run().finally(() => {
        this.running = null;
        this.schedule(DAY_MS);
      });
    }, delay);
  }

  private async run(): Promise<void> {
    try {
      const result = await this.cleanup();
      logger.info('History cleanup finished',
        `cutoff=${result.cutoff.toISOString()} history=${result.history} notifications=${result.notifications}`);
    } catch (error) {
      logger.error('History cleanup failed - will retry next day', error);
    }
  }
}

export const historyScheduler = new HistoryScheduler();
