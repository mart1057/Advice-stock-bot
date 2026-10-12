import { env } from '../config/env.js';

export interface CooldownGate {
  skip: boolean;
  remainingMs: number;
  until: Date | null;
}

export interface CooldownEntry {
  /// True only on the transition healthy -> cooling down (so we alert once).
  entered: boolean;
  /// True when an existing cooldown was escalated to a longer one.
  escalated: boolean;
  cooldownMs: number;
  until: Date;
  level: number;
  consecutiveFailures: number;
}

export interface GuardSnapshot {
  active: boolean;
  level: number;
  consecutiveFailures: number;
  until: Date | null;
}

export interface RateLimitGuardOptions {
  triggerFailures: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
}

/**
 * Adaptive cooldown for when Advice starts pushing back (403/429/503).
 *
 * Instead of hammering at the same interval while blocked, the scheduler backs
 * off exponentially and then returns to normal on the first clean response:
 *
 *   fail #1        -> still within tolerance, keep the normal interval
 *   fail #2        -> cooldown  2 min   (level 0)
 *   fail while cooling -> 4 min, 8 min, 16 min ... capped at max
 *   first success  -> reset immediately to the normal interval
 *
 * Only Advice push-back escalates. Parse errors and ordinary network blips are
 * counted but never trigger a cooldown, because backing off does not help them.
 */
export class RateLimitGuard {
  private consecutiveFailures = 0;
  private level = 0;
  private active = false;
  private cooldownUntil: number | null = null;

  constructor(
    private readonly options: RateLimitGuardOptions = {
      triggerFailures: env.RATE_LIMIT_TRIGGER_FAILURES,
      baseCooldownMs: env.RATE_LIMIT_COOLDOWN_BASE_SECONDS * 1000,
      maxCooldownMs: env.RATE_LIMIT_COOLDOWN_MAX_SECONDS * 1000,
    },
  ) {}

  /// Asked by the scheduler before every tick.
  check(now: number = Date.now()): CooldownGate {
    if (this.cooldownUntil === null) return { skip: false, remainingMs: 0, until: null };

    const remainingMs = this.cooldownUntil - now;
    if (remainingMs <= 0) {
      // Cooldown elapsed: allow one probe. `active` stays true so a repeated
      // failure escalates instead of restarting at the base delay.
      this.cooldownUntil = null;
      return { skip: false, remainingMs: 0, until: null };
    }

    return { skip: true, remainingMs, until: new Date(this.cooldownUntil) };
  }

  recordRateLimited(now: number = Date.now()): CooldownEntry | null {
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures < this.options.triggerFailures && !this.active) {
      return null;
    }

    const entered = !this.active;
    if (!entered) this.level += 1;

    const cooldownMs = Math.min(
      this.options.baseCooldownMs * 2 ** this.level,
      this.options.maxCooldownMs,
    );

    this.active = true;
    this.cooldownUntil = now + cooldownMs;

    return {
      entered,
      escalated: !entered,
      cooldownMs,
      until: new Date(this.cooldownUntil),
      level: this.level,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /// Non-rate-limit failure: tracked, but never triggers a cooldown.
  recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  /// Returns true when this success ended an active cooldown.
  recordSuccess(): boolean {
    const recovered = this.active;
    this.consecutiveFailures = 0;
    this.level = 0;
    this.active = false;
    this.cooldownUntil = null;
    return recovered;
  }

  snapshot(): GuardSnapshot {
    return {
      active: this.active,
      level: this.level,
      consecutiveFailures: this.consecutiveFailures,
      until: this.cooldownUntil === null ? null : new Date(this.cooldownUntil),
    };
  }
}
