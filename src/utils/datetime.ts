const TZ = process.env.TZ ?? 'Asia/Bangkok';

/// 17/09/2026 23:30:15
export const formatThaiDateTime = (date: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(',', '');

/// 23:30:15
export const formatClock = (date: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
