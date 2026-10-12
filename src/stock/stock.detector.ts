import type { ProductStock, StockStatus } from './stock.types.js';

/// Minimal projection of a persisted Stock row that the detector needs.
export interface PreviousStockState {
  /// Last DEFINITIVE answer (UNKNOWN checks never overwrite it).
  available: boolean;
  /// Last OBSERVED status, may be UNKNOWN.
  status: StockStatus;
}

export interface DetectionDecision {
  /// Push an alert for this (variant x channel).
  shouldNotify: boolean;
  /// Write a StockHistory row (only on an observed change).
  shouldRecordHistory: boolean;
  /// Overwrite Stock.available. False while the observation is UNKNOWN.
  shouldUpdateAvailable: boolean;
  previousStatus: StockStatus;
  currentStatus: StockStatus;
  reason:
    | 'first-observation'
    | 'unknown-observation'
    | 'became-available'
    | 'became-unavailable'
    | 'unchanged';
}

/**
 * The single rule that guards the channels from spam:
 *
 *     previous.available === false && current === AVAILABLE   -> notify
 *
 * Everything else is silent. Notably:
 *   - first observation (empty DB / new variant / new channel) never notifies,
 *   - UNKNOWN never notifies and never overwrites the last known answer,
 *     so a Advice outage cannot manufacture a false "back in stock" edge,
 *   - AVAILABLE -> AVAILABLE on every 30s tick stays silent,
 *   - AVAILABLE -> UNAVAILABLE is recorded but not pushed.
 */
export const detectChange = (
  previous: PreviousStockState | null,
  current: ProductStock,
): DetectionDecision => {
  const currentStatus = current.status;
  const previousStatus: StockStatus = previous?.status ?? 'UNKNOWN';

  if (currentStatus === 'UNKNOWN') {
    return {
      shouldNotify: false,
      shouldRecordHistory: previousStatus !== 'UNKNOWN',
      shouldUpdateAvailable: false,
      previousStatus,
      currentStatus,
      reason: 'unknown-observation',
    };
  }

  if (previous === null) {
    // Seed the baseline silently - this is what makes the first run quiet.
    return {
      shouldNotify: false,
      shouldRecordHistory: true,
      shouldUpdateAvailable: true,
      previousStatus,
      currentStatus,
      reason: 'first-observation',
    };
  }

  if (currentStatus === 'AVAILABLE') {
    const becameAvailable = previous.available === false;
    return {
      shouldNotify: becameAvailable,
      shouldRecordHistory: becameAvailable,
      shouldUpdateAvailable: true,
      previousStatus,
      currentStatus,
      reason: becameAvailable ? 'became-available' : 'unchanged',
    };
  }

  const becameUnavailable = previous.available === true;
  return {
    shouldNotify: false,
    shouldRecordHistory: becameUnavailable,
    shouldUpdateAvailable: true,
    previousStatus,
    currentStatus,
    reason: becameUnavailable ? 'became-unavailable' : 'unchanged',
  };
};
