import { PRLine, Requirement } from './types.js';
import { calendarDaysDiff, parseUtcTimestampMs } from './date-utils.js';

/**
 * Policy Clause 2: Anti-splitting requirement clubbing.
 * - Sorted strictly by created_at ASC, pr_no ASC, pr_line ASC.
 * - NEW items are never clubbed (Clause 1.2).
 * - Joins earliest open requirement with same item, same plant,
 *   created within creationWindowDays calendar days of first line,
 *   and need-by date within needByWindowDays calendar days (either side) of first line.
 * - Emergency on any line elevates the entire requirement (Clause 2.3).
 */
export function clubPRLines(
  prLines: PRLine[],
  creationWindowDays = 14,
  needByWindowDays = 7
): Requirement[] {
  const sortedLines = [...prLines].sort((a, b) => {
    const timeDiff = parseUtcTimestampMs(a.created_at) - parseUtcTimestampMs(b.created_at);
    if (timeDiff !== 0) return timeDiff;
    const prDiff = a.pr_no.localeCompare(b.pr_no);
    if (prDiff !== 0) return prDiff;
    return a.pr_line - b.pr_line;
  });

  const requirements: Requirement[] = [];
  let reqCounter = 1;

  for (const line of sortedLines) {
    const resolvedCode = line.resolved_item_code || 'NEW';

    // Clause 1.2: New items are never clubbed
    if (resolvedCode === 'NEW') {
      requirements.push({
        group_id: `GRP-${String(reqCounter++).padStart(4, '0')}`,
        resolved_item_code: 'NEW',
        plant: line.plant,
        first_created_at: line.created_at,
        first_need_by_date: line.need_by_date,
        lines: [line],
        total_quantity: line.quantity,
        is_emergency: line.urgency === 'Emergency'
      });
      continue;
    }

    let targetReq: Requirement | null = null;
    for (const req of requirements) {
      if (req.resolved_item_code === resolvedCode && req.plant === line.plant) {
        const createdDelta = calendarDaysDiff(req.first_created_at, line.created_at);
        const needByDelta = calendarDaysDiff(req.first_need_by_date, line.need_by_date);
        if (createdDelta <= creationWindowDays && needByDelta <= needByWindowDays) {
          targetReq = req;
          break; // Clause 2.2: joins earliest qualifying requirement
        }
      }
    }

    if (targetReq) {
      targetReq.lines.push(line);
      targetReq.total_quantity = Number((targetReq.total_quantity + line.quantity).toFixed(6));
      if (line.urgency === 'Emergency') {
        targetReq.is_emergency = true;
      }
    } else {
      requirements.push({
        group_id: `GRP-${String(reqCounter++).padStart(4, '0')}`,
        resolved_item_code: resolvedCode,
        plant: line.plant,
        first_created_at: line.created_at,
        first_need_by_date: line.need_by_date,
        lines: [line],
        total_quantity: line.quantity,
        is_emergency: line.urgency === 'Emergency'
      });
    }
  }

  return requirements;
}
