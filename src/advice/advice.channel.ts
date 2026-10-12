import { env } from '../config/env.js';
import type { AdviceChannel } from './advice.types.js';

/**
 * The stock flags on Advice's PDP describe the ONLINE order flow
 * ("เพิ่มลงตะกร้า" / "ซื้อเลย"). A single channel row stands in for it; the
 * schema keeps a store dimension so per-branch stock can be added later
 * without touching anything downstream.
 */
export const ONLINE_CHANNEL: AdviceChannel = {
  code: 'ONLINE',
  name: 'Advice Online',
  rawName: 'www.advice.co.th',
  country: 'TH',
  storeUrl: env.ADVICE_PRODUCT_URL,
};
