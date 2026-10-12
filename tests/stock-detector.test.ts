import { describe, expect, it } from 'vitest';
import { detectChange, type PreviousStockState } from '../src/stock/stock.detector.js';
import type { ProductStock, StockStatus } from '../src/stock/stock.types.js';

const observation = (status: StockStatus): ProductStock => ({
  model: 'iPhone 18 Pro Max',
  color: 'Burgundy',
  colorTh: 'เบอร์กันดี',
  storage: '256GB',
  partNumber: 'MJXQ4ZP/A',
  basePart: 'MJXQ4',
  priceTHB: 52900,
  storeName: 'Advice Online Store',
  storeCode: 'R733',
  status,
  available: status === 'AVAILABLE',
  checkedAt: new Date('2026-09-18T16:30:15.000Z'),
});

const previous = (available: boolean, status: StockStatus = available ? 'AVAILABLE' : 'UNAVAILABLE'): PreviousStockState => ({
  available,
  status,
});

describe('change detection truth table', () => {
  it('false -> false = no notification', () => {
    const decision = detectChange(previous(false), observation('UNAVAILABLE'));
    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe('unchanged');
  });

  it('false -> true = notification', () => {
    const decision = detectChange(previous(false), observation('AVAILABLE'));
    expect(decision.shouldNotify).toBe(true);
    expect(decision.reason).toBe('became-available');
    expect(decision.shouldRecordHistory).toBe(true);
  });

  it('true -> true = no notification', () => {
    const decision = detectChange(previous(true), observation('AVAILABLE'));
    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe('unchanged');
  });

  it('true -> false = no notification (but recorded)', () => {
    const decision = detectChange(previous(true), observation('UNAVAILABLE'));
    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe('became-unavailable');
    expect(decision.shouldRecordHistory).toBe(true);
  });
});

describe('first run', () => {
  it('empty database + available stock = no notification', () => {
    const decision = detectChange(null, observation('AVAILABLE'));
    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe('first-observation');
    expect(decision.shouldUpdateAvailable).toBe(true);
  });

  it('empty database + unavailable stock = no notification', () => {
    expect(detectChange(null, observation('UNAVAILABLE')).shouldNotify).toBe(false);
  });
});

describe('restart safety', () => {
  it('existing available stock + available = no notification', () => {
    // Baseline reloaded from PostgreSQL after a restart.
    const decision = detectChange(previous(true), observation('AVAILABLE'));
    expect(decision.shouldNotify).toBe(false);
  });

  it('re-alerts after the item sold out and came back', () => {
    expect(detectChange(previous(true), observation('UNAVAILABLE')).shouldNotify).toBe(false);
    expect(detectChange(previous(false), observation('AVAILABLE')).shouldNotify).toBe(true);
  });
});

describe('UNKNOWN handling', () => {
  it('never notifies and never overwrites the last known answer', () => {
    const decision = detectChange(previous(true), observation('UNKNOWN'));
    expect(decision.shouldNotify).toBe(false);
    expect(decision.shouldUpdateAvailable).toBe(false);
    expect(decision.reason).toBe('unknown-observation');
  });

  it('an outage cannot manufacture a false false->true edge', () => {
    // available -> (Advice down) -> available must stay silent.
    const duringOutage = detectChange(previous(true), observation('UNKNOWN'));
    expect(duringOutage.shouldUpdateAvailable).toBe(false);

    // `available` in the DB is still true, so recovery is silent.
    const afterOutage = detectChange(previous(true, 'UNKNOWN'), observation('AVAILABLE'));
    expect(afterOutage.shouldNotify).toBe(false);
  });

  it('still alerts when the item genuinely arrives after an outage', () => {
    const decision = detectChange(previous(false, 'UNKNOWN'), observation('AVAILABLE'));
    expect(decision.shouldNotify).toBe(true);
  });

  it('first observation that is UNKNOWN stays silent', () => {
    const decision = detectChange(null, observation('UNKNOWN'));
    expect(decision.shouldNotify).toBe(false);
    expect(decision.shouldUpdateAvailable).toBe(false);
  });
});

describe('repeated available ticks (the LINE spam guard)', () => {
  it('sends exactly once across a 10:00-10:06 timeline', () => {
    const timeline: StockStatus[] = [
      'UNAVAILABLE', // 10:00
      'AVAILABLE', // 10:01 -> notify
      'AVAILABLE', // 10:02
      'AVAILABLE', // 10:03
      'AVAILABLE', // 10:04
      'UNAVAILABLE', // 10:05
      'AVAILABLE', // 10:06 -> notify again
    ];

    let state: PreviousStockState | null = null;
    const notified: number[] = [];

    timeline.forEach((status, index) => {
      const decision = detectChange(state, observation(status));
      if (decision.shouldNotify) notified.push(index);
      state = {
        available: decision.shouldUpdateAvailable ? status === 'AVAILABLE' : (state?.available ?? false),
        status,
      };
    });

    expect(notified).toEqual([1, 6]);
  });
});
