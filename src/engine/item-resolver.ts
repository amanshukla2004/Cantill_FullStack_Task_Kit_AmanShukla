import { Item } from './types.js';

export interface MatchedItemResult {
  resolved_item_code: string; // 'ITM-XXXX' or 'NEW'
  is_new: boolean;
  match_confidence: number;
  had_text_urgent_tag: boolean;
  candidates?: Array<{ item_code: string; description: string; score: number }>;
}

const ABBREVIATION_MAP: Record<string, string[]> = {
  brg: ['ball', 'bearing'],
  brgs: ['ball', 'bearing'],
  hyd: ['hydraulic'],
  pneu: ['pneumatic'],
  rod: ['electrode'],
  rods: ['electrode'],
  ss: ['ss'],
  ms: ['ms'],
  vci: ['vci'],
  frl: ['frl'],
  cmm: ['cmm'],
  eot: ['eot'],
  mcb: ['mcb'],
  cnc: ['cnc'],
  led: ['led']
};

const STOP_WORDS = new Set(['for', 'the', 'of', 'with', 'and', 'in', 'to', 'a', 'an']);

export function stripOperationalNoise(raw: string): {
  cleaned: string;
  hadUrgentTag: boolean;
} {
  const hadUrgentTag = /\s*-\s*urgent\b/i.test(raw);
  const cleaned = raw
    .replace(/\s*-\s*urgent\b/gi, '')
    .replace(/\s*\bfor\s+maintenance\b/gi, '')
    .replace(/\s*\bas\s+per\s+sample\b/gi, '')
    .replace(/\s*\(repeat\)/gi, '')
    .replace(/×/g, 'x')
    // Convert 24" -> 24 inch before stripping quotes
    .replace(/(\d+(?:\.\d+)?)\s*"/g, '$1 inch')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { cleaned, hadUrgentTag };
}

export function normalizeTokens(text: string): string[] {
  const lower = text
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[()[\],;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Split on whitespace, keeping hyphenated specs both intact and split for robust matching
  const rawParts = lower.split(/\s+/).filter(Boolean);
  const expanded: string[] = [];

  for (const part of rawParts) {
    if (STOP_WORDS.has(part) || part === '-') continue;

    // Context-aware 'brg': if preceded by 'roller', expand to just ['bearing'] instead of ['ball', 'bearing']
    if (part === 'brg' || part === 'brgs') {
      if (expanded[expanded.length - 1] === 'roller') {
        expanded.push('bearing');
      } else {
        expanded.push('ball', 'bearing');
      }
      continue;
    }

    if (ABBREVIATION_MAP[part]) {
      expanded.push(...ABBREVIATION_MAP[part]);
      continue;
    }

    // Handle hyphenated codes like "6308-zz" or "6205-2rs" or "b-54" or "l-100"
    if (part.includes('-')) {
      const subParts = part.split('-').filter(Boolean);
      for (const sp of subParts) {
        expanded.push(sp);
      }
    } else {
      expanded.push(part);
    }
  }

  return expanded;
}

function extractNumericTokens(tokens: string[]): string[] {
  return tokens.filter((t) => /\d/.test(t));
}

function hasNumericConflict(qNums: string[], iNums: string[]): boolean {
  if (qNums.length === 0 || iNums.length === 0) return false;
  for (const qn of qNums) {
    // Allow exact or dimension-token match; reject conflicting model/size numbers (e.g. 6308 vs 6205)
    const matched = iNums.some(
      (inm) => inm === qn || inm.replace(/mm|kg|ltr|w|a|v|kw|hp|gb|lph$/i, '') === qn.replace(/mm|kg|ltr|w|a|v|kw|hp|gb|lph$/i, '')
    );
    if (!matched) {
      return true;
    }
  }
  return false;
}

export function findCatalogCandidates(
  rawDescription: string,
  catalog: Map<string, Item>,
  limit = 5
): Array<{ item_code: string; description: string; score: number }> {
  const { cleaned } = stripOperationalNoise(rawDescription);
  const qTokens = normalizeTokens(cleaned);
  if (qTokens.length === 0) return [];

  const qSet = new Set(qTokens);
  const qNums = extractNumericTokens(qTokens);
  const scored: Array<{ item_code: string; description: string; score: number }> = [];

  for (const [code, item] of catalog.entries()) {
    const iTokens = normalizeTokens(item.description);
    const iSet = new Set(iTokens);
    const iNums = extractNumericTokens(iTokens);

    if (hasNumericConflict(qNums, iNums)) continue;

    let overlap = 0;
    for (const qt of qSet) {
      if (iSet.has(qt)) overlap++;
    }
    if (overlap === 0) continue;

    // Symmetric Jaccard-like + coverage blend
    const maxLen = Math.max(qSet.size, iSet.size);
    const score = overlap / maxLen;
    scored.push({ item_code: code, description: item.description, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.item_code.localeCompare(b.item_code))
    .slice(0, limit);
}

export function resolveItem(
  rawItemCode: string | null | undefined,
  rawDescription: string,
  catalog: Map<string, Item>
): MatchedItemResult {
  const { cleaned, hadUrgentTag } = stripOperationalNoise(rawDescription || '');

  // Step 1: Explicit valid item code (Clause 1.1)
  if (rawItemCode && rawItemCode.trim()) {
    const code = rawItemCode.trim().toUpperCase();
    if (catalog.has(code)) {
      return {
        resolved_item_code: code,
        is_new: false,
        match_confidence: 1.0,
        had_text_urgent_tag: hadUrgentTag
      };
    }
  }

  // Step 2: Case-insensitive exact match after noise stripping
  const lowerClean = cleaned.toLowerCase();
  for (const [code, item] of catalog.entries()) {
    const itemClean = item.description.replace(/×/g, 'x').trim().toLowerCase();
    if (itemClean === lowerClean) {
      return {
        resolved_item_code: code,
        is_new: false,
        match_confidence: 1.0,
        had_text_urgent_tag: hadUrgentTag
      };
    }
  }

  // Step 3: Normalized token match with strict numeric/part-code preservation
  const candidates = findCatalogCandidates(cleaned, catalog, 5);
  if (candidates.length > 0) {
    const best = candidates[0];
    // Require strong token overlap (>= 0.55) to avoid false positives on novel items
    // (e.g., "Drinking water purifier 50 LPH" or "Ultrasonic thickness gauge" score ~0)
    if (best.score >= 0.55) {
      return {
        resolved_item_code: best.item_code,
        is_new: false,
        match_confidence: Number(best.score.toFixed(3)),
        had_text_urgent_tag: hadUrgentTag,
        candidates
      };
    }
  }

  // Step 4: Unmatched -> NEW item (Clause 1.2)
  return {
    resolved_item_code: 'NEW',
    is_new: true,
    match_confidence: 0,
    had_text_urgent_tag: hadUrgentTag,
    candidates
  };
}
