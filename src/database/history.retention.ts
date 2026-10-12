import type { PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';

export const HISTORY_RETENTION_MS = 72 * 60 * 60 * 1000;

export async function pruneHistory(now = new Date(), db: PrismaClient = prisma) {
  const cutoff = new Date(now.getTime() - HISTORY_RETENTION_MS);
  // Delete children only. Stock is the notification baseline and must survive.
  // Limit DB time so maintenance cannot hold resources indefinitely.
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    const history = await tx.stockHistory.deleteMany({
      where: { checkedAt: { lt: cutoff } },
    });
    const notifications = await tx.notificationLog.deleteMany({
      where: { sentAt: { lt: cutoff } },
    });
    return { cutoff, history: history.count, notifications: notifications.count };
  }, { maxWait: 2000, timeout: 12_000 });
}
