/**
 * Deterministic query expansion for LongMemEval benchmark.
 * Adapted from OMEGA's _expand_query() and _resolve_relative_dates().
 *
 * Zero LLM cost — pure regex + date arithmetic.
 * Appends resolved absolute dates, entity terms, and counting signals
 * to the search query for better BM25/FTS5 matching.
 */

const WORD_TO_NUM: Record<string, number> = {
  one: 1, a: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, twenty: 20, thirty: 30,
};

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Parse LongMemEval date format "YYYY/MM/DD (Day) HH:MM" to Date object.
 */
function parseAnchorDate(dateStr: string): Date | null {
  const cleaned = dateStr.replace(/\s*\([A-Za-z]+\)\s*/, " ").trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function formatMonthDay(d: Date): string {
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Resolve relative date references in a query to absolute date keywords.
 * Returns keywords to append to the query for better BM25 matching.
 */
function resolveRelativeDates(query: string, anchor: Date): string[] {
  const qLower = query.toLowerCase();
  const resolved: string[] = [];

  // "last (Monday|Tuesday|...)" → absolute date
  const dayMatch = query.match(/last\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i);
  if (dayMatch) {
    const dayName = dayMatch[1].charAt(0).toUpperCase() + dayMatch[1].slice(1).toLowerCase();
    const dayMap: Record<string, number> = {};
    DAY_NAMES.forEach((d, i) => { dayMap[d] = i; });
    const targetWeekday = dayMap[dayName];
    if (targetWeekday !== undefined) {
      let daysBack = (anchor.getDay() - targetWeekday) % 7;
      if (daysBack <= 0) daysBack += 7;
      const target = new Date(anchor.getTime() - daysBack * 86400000);
      resolved.push(`${dayName} ${formatDate(target)} ${formatMonthDay(target)}`);
    }
  }

  // "last weekend"
  if (qLower.includes("last weekend")) {
    const satBack = (anchor.getDay() + 1) % 7 || 7;
    const sat = new Date(anchor.getTime() - satBack * 86400000);
    const sun = new Date(sat.getTime() + 86400000);
    resolved.push(`Saturday Sunday ${formatDate(sat)} ${formatDate(sun)}`);
  }

  // "yesterday"
  if (qLower.includes("yesterday")) {
    const yest = new Date(anchor.getTime() - 86400000);
    resolved.push(`${formatDate(yest)} ${formatMonthDay(yest)}`);
  }

  // "N days/weeks/months/years ago"
  const agoMatch = query.match(/(\d+|[a-z]+)\s+(day|week|month|year)s?\s+ago/i);
  if (agoMatch) {
    const rawN = agoMatch[1].toLowerCase();
    const n = rawN.match(/^\d+$/) ? parseInt(rawN) : WORD_TO_NUM[rawN];
    if (n !== undefined) {
      const unit = agoMatch[2].toLowerCase();
      let deltaMs = 0;
      if (unit === "day") deltaMs = n * 86400000;
      else if (unit === "week") deltaMs = n * 7 * 86400000;
      else if (unit === "month") deltaMs = n * 30 * 86400000;
      else if (unit === "year") deltaMs = n * 365 * 86400000;
      if (deltaMs > 0) {
        const center = new Date(anchor.getTime() - deltaMs);
        resolved.push(`${formatDate(center)} ${MONTH_NAMES[center.getMonth()]} ${center.getDate()}`);
      }
    }
  }

  // "last/past N days/weeks/months"
  const lastMatch = query.match(/(?:last|past|previous)\s+(\d+|[a-z]+)\s+(day|week|month|year)s?/i);
  if (lastMatch) {
    const rawN = lastMatch[1].toLowerCase();
    const n = rawN.match(/^\d+$/) ? parseInt(rawN) : WORD_TO_NUM[rawN];
    if (n !== undefined) {
      const unit = lastMatch[2].toLowerCase();
      let deltaMs = 0;
      if (unit === "day") deltaMs = n * 86400000;
      else if (unit === "week") deltaMs = n * 7 * 86400000;
      else if (unit === "month") deltaMs = n * 30 * 86400000;
      else if (unit === "year") deltaMs = n * 365 * 86400000;
      if (deltaMs > 0) {
        const start = new Date(anchor.getTime() - deltaMs);
        resolved.push(`${formatDate(start)} ${formatDate(anchor)} ${MONTH_NAMES[start.getMonth()]} ${MONTH_NAMES[anchor.getMonth()]}`);
      }
    }
  }

  // "in [Month]" (without year)
  const monthMatch = query.match(/in\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
  if (monthMatch && !query.match(new RegExp(`in\\s+${monthMatch[1]}\\s+\\d{4}`, "i"))) {
    const monthName = monthMatch[1].charAt(0).toUpperCase() + monthMatch[1].slice(1).toLowerCase();
    const monthNum = MONTH_NAMES.indexOf(monthName);
    if (monthNum >= 0) {
      const year = monthNum <= anchor.getMonth() ? anchor.getFullYear() : anchor.getFullYear() - 1;
      resolved.push(`${monthName} ${year} ${year}-${String(monthNum + 1).padStart(2, "0")}`);
    }
  }

  // "in [Month] [Year]"
  const monthYearMatch = query.match(/in\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (monthYearMatch) {
    const monthName = monthYearMatch[1].charAt(0).toUpperCase() + monthYearMatch[1].slice(1).toLowerCase();
    const year = parseInt(monthYearMatch[2]);
    const monthNum = MONTH_NAMES.indexOf(monthName);
    if (monthNum >= 0) {
      resolved.push(`${monthName} ${year} ${year}-${String(monthNum + 1).padStart(2, "0")}`);
    }
  }

  return resolved;
}

/**
 * Common words to exclude from entity extraction.
 */
const COMMON_WORDS = new Set([
  "I", "The", "A", "An", "My", "What", "When", "Where", "Who", "How",
  "Which", "Why", "Do", "Does", "Did", "Is", "Are", "Was", "Were",
  "Have", "Has", "Had", "Can", "Could", "Would", "Should", "Will",
  "If", "In", "On", "At", "To", "For", "Of", "And", "Or", "But",
  "Not", "That", "This", "It", "He", "She", "They", "We", "You",
  "Please", "Tell", "Me", "About",
]);

/**
 * Expand a query with temporal, entity, and counting signals.
 * Deterministic — no LLM calls. Adapted from OMEGA's _expand_query().
 */
export function expandQuery(query: string, questionDate?: string): string {
  const expansions: string[] = [];

  // 1. Counting signals
  const qLower = query.toLowerCase();
  if (/how many|how much|how often|total number|count/i.test(qLower)) {
    expansions.push("every instance all occurrences each time");
  }

  // 2. Temporal resolution
  if (questionDate) {
    const anchor = parseAnchorDate(questionDate);
    if (anchor) {
      const resolved = resolveRelativeDates(query, anchor);
      expansions.push(...resolved);
    }
  }

  // 3. Entity extraction — proper nouns
  const words = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
  const entities = words.filter(w => !COMMON_WORDS.has(w) && w.length > 1);
  if (entities.length > 0) {
    expansions.push(entities.join(" "));
  }

  if (expansions.length === 0) return query;
  return query + " " + expansions.join(" ");
}

/**
 * Category-specific minimum relevance thresholds.
 * Results below these thresholds are filtered out before the answer model sees them.
 * Adapted from OMEGA's _CATEGORY_CONFIG.
 */
export const MIN_RELEVANCE: Record<string, number> = {
  "single-session-assistant": 0.10,
  "single-session-user": 0.08,
  "single-session-preference": 0.08,
  "multi-session": 0.05,
  "temporal-reasoning": 0.06,
  "knowledge-update": 0.10,
};

/**
 * Filter search results by minimum relevance score.
 * Keeps at least minResults even if below threshold (OMEGA's min_res).
 */
export function filterByRelevance(
  results: Array<{ score: number; [key: string]: any }>,
  questionType: string,
  minResults: number = 3
): typeof results {
  const threshold = MIN_RELEVANCE[questionType] ?? 0.08;
  const above = results.filter(r => r.score >= threshold);
  if (above.length >= minResults) return above;
  // Keep at least minResults even if below threshold
  return results.slice(0, Math.max(minResults, above.length));
}
