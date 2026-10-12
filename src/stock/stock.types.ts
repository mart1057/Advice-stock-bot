export type StockStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

/// Normalised, source-agnostic view of one (variant x store) observation.
export interface ProductStock {
  model: string;
  color: string; // canonical English, e.g. "Burgundy"
  colorTh: string; // Thai display, e.g. "เบอร์กันดี"
  storage: string; // "256GB"
  sku: string; // "A0186084" - Advice item code
  priceTHB: number | null;
  /// Deep link straight to this colour+capacity on the PDP.
  url: string;

  storeName: string; // "Advice Online Store"
  storeCode?: string; // "ONLINE"

  status: StockStatus;
  /// Convenience mirror of status === 'AVAILABLE'. UNKNOWN is never `true`.
  available: boolean;
  /// Sellable units Advice reports. null when the response carried no quantity.
  quantity: number | null;
  /// Human readable quote, e.g. "พร้อมจำหน่าย (เหลือ 3 เครื่อง)"
  quote?: string;

  checkedAt: Date;
}

/// A false -> true edge. Only these produce a push.
export interface StockTransition {
  stockId: string;
  previousStatus: StockStatus;
  currentStatus: StockStatus;
  stock: ProductStock;
}

export interface StockCheckResult {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  checked: number;
  available: number;
  unavailable: number;
  unknown: number;
  transitions: StockTransition[];
  firstRun: boolean;
  errors: string[];
  /// Advice pushed back on at least one request this cycle.
  rateLimited: boolean;
}
