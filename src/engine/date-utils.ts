/**
 * Pure UTC date & timestamp helpers to avoid host timezone drift on Windows/Linux.
 */

export function extractDateOnly(dateTimeStr: string): string {
  const trimmed = dateTimeStr.trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : trimmed;
}

export function parseUtcDateMs(dateStr: string): number {
  const only = extractDateOnly(dateStr);
  const [y, m, d] = only.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function parseUtcTimestampMs(dateTimeStr: string): number {
  const trimmed = dateTimeStr.trim();
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!match) {
    return Date.parse(trimmed);
  }
  const [, y, m, d, hh = '00', mm = '00', ss = '00'] = match;
  return Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss)
  );
}

/**
 * Absolute calendar days difference between two YYYY-MM-DD (or timestamp) strings.
 */
export function calendarDaysDiff(dateA: string, dateB: string): number {
  const msPerDay = 86_400_000;
  return Math.abs(Math.round((parseUtcDateMs(dateB) - parseUtcDateMs(dateA)) / msPerDay));
}

/**
 * Signed calendar days (dateB - dateA).
 */
export function signedCalendarDaysDiff(dateA: string, dateB: string): number {
  const msPerDay = 86_400_000;
  return Math.round((parseUtcDateMs(dateB) - parseUtcDateMs(dateA)) / msPerDay);
}

/**
 * Subtract N calendar days from a YYYY-MM-DD date string, returning YYYY-MM-DD.
 */
export function subtractDays(dateStr: string, days: number): string {
  const ms = parseUtcDateMs(dateStr) - days * 86_400_000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Hours elapsed from tsA to tsB (tsB - tsA).
 */
export function hoursDiff(tsA: string, tsB: string): number {
  return (parseUtcTimestampMs(tsB) - parseUtcTimestampMs(tsA)) / 3_600_000;
}

/**
 * Minutes elapsed from tsA to tsB (tsB - tsA).
 */
export function minutesDiff(tsA: string, tsB: string): number {
  return (parseUtcTimestampMs(tsB) - parseUtcTimestampMs(tsA)) / 60_000;
}
