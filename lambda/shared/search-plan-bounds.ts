/** FAQ orchestration と KB injection が共有する search-plan 有界化ポリシー。 */
export type SearchPlanTextOverflowPolicy = 'drop' | 'truncate';

export interface BoundedPlanTexts {
  texts: string[];
  /**
   * Code-point-overflow drops only (policy 'drop'). Items cut by the maxItems count limit are
   * NOT counted here — observe count-limit overflow as rawCount - texts.length instead.
   */
  droppedCount: number;
  /** Item count after NFKC/case-insensitive dedup, before any limit is applied. */
  rawCount: number;
}

/**
 * Bound model-produced search-plan text without failing the whole request.
 *
 * Duplicate detection uses case-insensitive NFKC keys, while returned values retain their
 * trimmed original spelling. Limits and truncation are measured in Unicode code points so a
 * surrogate pair is never split.
 */
export function boundPlanTexts(
  values: unknown,
  maxItems: number,
  maxCodePoints: number,
  overflow: SearchPlanTextOverflowPolicy
): BoundedPlanTexts {
  const seen = new Set<string>();
  const rawItems = (Array.isArray(values) ? values : [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => {
      const key = value.normalize('NFKC').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  let droppedCount = 0;
  const texts: string[] = [];
  for (const value of rawItems) {
    if (texts.length >= maxItems) break;
    const codePoints = Array.from(value);
    if (codePoints.length <= maxCodePoints) {
      texts.push(value);
    } else if (overflow === 'drop') {
      droppedCount++;
    } else {
      texts.push(codePoints.slice(0, maxCodePoints).join(''));
    }
  }

  return { texts, droppedCount, rawCount: rawItems.length };
}
