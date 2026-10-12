import { Prisma, type PrismaClient } from '@prisma/client';
import type { AdviceChannel, AdviceVariant } from '../advice/advice.types.js';
import { prisma as defaultPrisma } from '../database/prisma.js';
import type { ProductStock, StockStatus } from './stock.types.js';
import type { PreviousStockState } from './stock.detector.js';

export interface StockRow {
  id: string;
  variantId: string;
  storeId: string;
  available: boolean;
  status: StockStatus;
}

export interface StockPersistInput {
  stockId: string;
  status: StockStatus;
  available: boolean;
  /// Sellable units observed, or null when the observation was UNKNOWN.
  quantity: number | null;
  updateAvailable: boolean;
  recordHistory: boolean;
  checkedAt: Date;
}

export class StockRepository {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  async upsertProduct(model: string): Promise<string> {
    const product = await this.db.product.upsert({
      where: { model },
      create: { model },
      update: {},
      select: { id: true },
    });
    return product.id;
  }

  async upsertVariants(productId: string, variants: readonly AdviceVariant[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();

    for (const variant of variants) {
      const data = {
        productId,
        color: variant.color,
        colorTh: variant.colorTh,
        colorKey: variant.colorKey,
        colorCode: variant.colorCode,
        storage: variant.storage,
        url: variant.url,
        priceTHB: variant.priceTHB === null ? null : new Prisma.Decimal(variant.priceTHB),
      };

      const row = await this.db.productVariant.upsert({
        where: { sku: variant.sku },
        create: { sku: variant.sku, ...data },
        update: data,
        select: { id: true },
      });
      ids.set(variant.sku, row.id);
    }

    return ids;
  }

  async upsertChannels(channels: readonly AdviceChannel[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();

    for (const channel of channels) {
      const data = {
        name: channel.name,
        rawName: channel.rawName,
        country: channel.country,
        storeUrl: channel.storeUrl ?? null,
      };

      const row = await this.db.store.upsert({
        where: { code: channel.code },
        create: { code: channel.code, ...data },
        update: data,
        select: { id: true },
      });
      ids.set(channel.code, row.id);
    }

    return ids;
  }

  /// Loads the persisted baseline. This is what makes restarts safe: state
  /// lives in PostgreSQL, never only in memory.
  async loadPreviousStates(): Promise<Map<string, StockRow>> {
    const rows = await this.db.stock.findMany({
      select: {
        id: true,
        available: true,
        status: true,
        variant: { select: { sku: true } },
        store: { select: { code: true } },
        variantId: true,
        storeId: true,
      },
    });

    return new Map(
      rows.map((row) => [
        stockKey(row.variant.sku, row.store.code),
        {
          id: row.id,
          variantId: row.variantId,
          storeId: row.storeId,
          available: row.available,
          status: row.status as StockStatus,
        },
      ]),
    );
  }

  async countStocks(): Promise<number> {
    return this.db.stock.count();
  }

  /// Creates the (variant x channel) row on first sight and returns its state.
  async ensureStock(
    variantId: string,
    storeId: string,
    current: ProductStock,
  ): Promise<{ id: string; previous: PreviousStockState | null }> {
    const existing = await this.db.stock.findUnique({
      where: { variantId_storeId: { variantId, storeId } },
      select: { id: true, available: true, status: true },
    });

    if (existing) {
      return {
        id: existing.id,
        previous: { available: existing.available, status: existing.status as StockStatus },
      };
    }

    const created = await this.db.stock.create({
      data: {
        variantId,
        storeId,
        available: current.status === 'AVAILABLE',
        status: current.status,
        quantity: current.quantity,
        lastCheckedAt: current.checkedAt,
        lastAvailableAt: current.status === 'AVAILABLE' ? current.checkedAt : null,
      },
      select: { id: true },
    });

    return { id: created.id, previous: null };
  }

  async persist(input: StockPersistInput): Promise<void> {
    const data: Prisma.StockUpdateInput = {
      status: input.status,
      lastCheckedAt: input.checkedAt,
    };

    if (input.updateAvailable) {
      data.available = input.available;
      // Quantity mirrors `available`: an UNKNOWN check must not blank the
      // last known count.
      data.quantity = input.quantity;
      if (input.available) data.lastAvailableAt = input.checkedAt;
    }

    await this.db.$transaction(async (tx) => {
      await tx.stock.update({ where: { id: input.stockId }, data });

      if (input.recordHistory) {
        await tx.stockHistory.create({
          data: {
            stockId: input.stockId,
            available: input.updateAvailable ? input.available : null,
            quantity: input.updateAvailable ? input.quantity : null,
            status: input.status,
            checkedAt: input.checkedAt,
          },
        });
      }
    });
  }

  async logNotification(entry: {
    stockId: string;
    previousStatus: StockStatus;
    currentStatus: StockStatus;
    messageId: string | null;
    success: boolean;
    error?: string;
  }): Promise<void> {
    await this.db.notificationLog.create({
      data: {
        stockId: entry.stockId,
        previousStatus: entry.previousStatus,
        currentStatus: entry.currentStatus,
        messageId: entry.messageId,
        success: entry.success,
        error: entry.error ?? null,
      },
    });
  }

  // -- Cooperative lock (multi-instance safety) -----------------------------

  /// Atomically grabs `name` unless a non-expired lock is already held.
  async acquireLock(name: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const [taken] = await this.db.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      INSERT INTO job_locks (name, owner, locked_at, expires_at)
      VALUES (${name}, ${owner}, ${now}, ${expiresAt})
      ON CONFLICT (name) DO UPDATE
        SET owner = EXCLUDED.owner,
            locked_at = EXCLUDED.locked_at,
            expires_at = EXCLUDED.expires_at
        WHERE job_locks.expires_at < ${now}
      RETURNING name
    `);

    return taken !== undefined;
  }

  async releaseLock(name: string, owner: string): Promise<void> {
    await this.db.jobLock.deleteMany({ where: { name, owner } });
  }
}

export const stockKey = (sku: string, channelCode: string | undefined): string =>
  `${sku}::${channelCode ?? 'unknown-channel'}`;

export const stockRepository = new StockRepository();
