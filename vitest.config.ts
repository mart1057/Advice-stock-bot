import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The bot validates its environment at import time; give tests a valid one.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      TZ: 'Asia/Bangkok',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/iphone_stock_bot_test',
      LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
      LINE_USER_ID: 'Utestuser',
      LINE_DRY_RUN: 'true',
      APPLE_MODEL_FILTER: 'iPhone 18 Pro Max',
    },
  },
});
