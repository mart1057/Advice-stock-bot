import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

export const prisma = new PrismaClient({
  log: env.LOG_LEVEL === 'debug' ? ['warn', 'error', 'query'] : ['warn', 'error'],
});

export const disconnectPrisma = async (): Promise<void> => {
  await prisma.$disconnect();
};
