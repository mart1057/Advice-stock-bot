import { describe, expect, it } from 'vitest';
import { RateLimitGuard } from '../src/scheduler/rate-limit.guard.js';
import { AdviceRequestError, isRateLimitError } from '../src/advice/advice.types.js';

const guard = () =>
  new RateLimitGuard({ triggerFailures: 2, baseCooldownMs: 120_000, maxCooldownMs: 1_800_000 });

describe('which errors count as Advice pushing back', () => {
  it('treats 403 / 429 / 503 as rate limiting', () => {
    for (const status of [403, 429, 503]) {
      expect(isRateLimitError(new AdviceRequestError('x', status))).toBe(true);
    }
  });

  it('does not treat parse errors, 404 or plain failures as rate limiting', () => {
    expect(isRateLimitError(new AdviceRequestError('x', 404))).toBe(false);
    expect(isRateLimitError(new AdviceRequestError('bad shape', undefined, false))).toBe(false);
    expect(isRateLimitError(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('adaptive cooldown', () => {
  it('tolerates a single push-back without pausing', () => {
    const g = guard();
    expect(g.recordRateLimited(0)).toBeNull();
    expect(g.check(0).skip).toBe(false);
  });

  it('pauses after the second consecutive push-back', () => {
    const g = guard();
    g.recordRateLimited(0);
    const entry = g.recordRateLimited(0);

    expect(entry).not.toBeNull();
    expect(entry?.entered).toBe(true);
    expect(entry?.cooldownMs).toBe(120_000);
    expect(g.check(0)).toMatchObject({ skip: true });
  });

  it('skips ticks until the cooldown elapses, then allows a probe', () => {
    const g = guard();
    g.recordRateLimited(0);
    g.recordRateLimited(0);

    expect(g.check(60_000).skip).toBe(true);
    expect(Math.round(g.check(60_000).remainingMs / 1000)).toBe(60);
    expect(g.check(120_001).skip).toBe(false); // probe allowed
  });

  it('doubles the cooldown on each further push-back', () => {
    const g = guard();
    g.recordRateLimited(0);
    expect(g.recordRateLimited(0)?.cooldownMs).toBe(120_000); // 2 min
    expect(g.recordRateLimited(0)?.cooldownMs).toBe(240_000); // 4 min
    expect(g.recordRateLimited(0)?.cooldownMs).toBe(480_000); // 8 min
    expect(g.recordRateLimited(0)?.cooldownMs).toBe(960_000); // 16 min
  });

  it('caps the cooldown at the configured maximum', () => {
    const g = guard();
    g.recordRateLimited(0);
    let last = 0;
    for (let i = 0; i < 12; i += 1) last = g.recordRateLimited(0)?.cooldownMs ?? 0;
    expect(last).toBe(1_800_000); // 30 min cap
  });

  it('only reports `entered` once per episode (so LINE is alerted once)', () => {
    const g = guard();
    g.recordRateLimited(0);
    expect(g.recordRateLimited(0)?.entered).toBe(true);
    expect(g.recordRateLimited(0)?.entered).toBe(false);
    expect(g.recordRateLimited(0)?.escalated).toBe(true);
  });

  it('resets to normal on the first clean response', () => {
    const g = guard();
    g.recordRateLimited(0);
    g.recordRateLimited(0);

    expect(g.recordSuccess()).toBe(true); // recovered -> alert
    expect(g.check(0).skip).toBe(false);
    expect(g.snapshot()).toMatchObject({ active: false, level: 0, consecutiveFailures: 0 });

    // A later success must not alert again.
    expect(g.recordSuccess()).toBe(false);
  });

  it('starts over at the base delay after a full recovery', () => {
    const g = guard();
    g.recordRateLimited(0);
    g.recordRateLimited(0);
    g.recordRateLimited(0); // escalated to 4 min
    g.recordSuccess();

    g.recordRateLimited(0);
    expect(g.recordRateLimited(0)?.cooldownMs).toBe(120_000);
  });

  it('does not let ordinary failures trigger a cooldown', () => {
    const g = guard();
    g.recordFailure();
    g.recordFailure();
    g.recordFailure();
    expect(g.check(0).skip).toBe(false);
    expect(g.snapshot().active).toBe(false);
  });
});
