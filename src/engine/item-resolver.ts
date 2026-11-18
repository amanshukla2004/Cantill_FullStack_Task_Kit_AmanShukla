import { Item } from './types.js';

export interface CatalogCandidate {
  item_code: string;
  description: string;
  score: number;
  query_coverage: number;
}

export interface MatchedItemResult {
  resolved_item_code: string; // 'ITM-XXXX' or 'NEW'
  is_new: boolean;
  match_confidence: number;
  had_text_urgent_tag: boolean;
  candidates?: CatalogCandidate[];
}

const ABBREVIATION_MAP: Record<string, string[]> = {
  brg: ['ball', 'bearing'],
  brgs: ['ball', 'bearing'],
  hyd: ['hydraulic'],
  pneu: ['pneumatic'],
  rod: ['electrode'],
  rods: ['electrode'],
  cyl: ['cylinder'],
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

const SPELLING_NORMALIZER: Record<string, string> = {
  center: 'centre',
  aluminum: 'aluminium',
  meter: 'metre',
  liter: 'litre',
  gray: 'grey'
};

const STOP_WORDS = new Set([
  'for',
  'the',
  'of',
  'with',
  'and',
  'in',
  'to',
  'a',
  'an',
  'some',
  'please',
  'need'
]);

const PLURAL_TO_SINGULAR: Record<string, string> = {
  bearings: 'bearing',
  bolts: 'bolt',
  nuts: 'nut',
  screws: 'screw',
  washers: 'washer',
  fasteners: 'fastener',
  valves: 'valve',
  cylinders: 'cylinder',
  hoses: 'hose',
  sheets: 'sheet',
  plates: 'plate',
  bars: 'bar',
  angles: 'angle',
  flats: 'flat',
  boxes: 'box',
  pallets: 'pallet',
  bags: 'bag',
  rolls: 'roll',
  helmets: 'helmet',
  sensors: 'sensor',
  cables: 'cable',
  lights: 'light',
  drives: 'drive',
  encoders: 'encoder',
  laptops: 'laptop',
  monitors: 'monitor',
  cranes: 'crane',
  forklifts: 'forklift',
  seals: 'seal',
  wheels: 'wheel',
  electrodes: 'electrode',
  sprockets: 'sprocket',
  contactors: 'contactor',
  cartridges: 'cartridge',
  compressors: 'compressor',
  presses: 'press',
  kits: 'kit',
  oils: 'oil',
  belts: 'belt',
  glove: 'gloves',
  shoe: 'shoes',
  goggle: 'goggles',
  plug: 'plugs'
};

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
    // Collapse spaced dimensions: "m10 x 40" -> "m10x40", "45 x 62 x 8" -> "45x62x8", "1250 x 2500" -> "1250x2500"
    .replace(
      /\b([a-z]?\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?\b/gi,
      (_, a: string, b: string, c?: string) => (c ? `${a}x${b}x${c}` : `${a}x${b}`)
    )
    // Split fused stainless/mild steel grades like "ss304" -> "ss 304"
    .replace(/\b(ss|ms)(\d{2,4})\b/g, '$1 $2')
    // Normalize spaced number+unit compounds: "30 hp" -> "30hp", "75 gsm" -> "75gsm", "1.5 mm" -> "1.5mm"
    .replace(
      /\b(\d+(?:\.\d+)?)\s+(hp|kw|w|a|gb|mm|kg|l|gsm|lph|cum|ply|ton|sqmm|micron)\b/g,
      '$1$2'
    )
    .replace(/\s+/g, ' ')
    .trim();

  const rawParts = lower.split(/\s+/).filter(Boolean);
  const expanded: string[] = [];

  for (const rawPart of rawParts) {
    const part = SPELLING_NORMALIZER[rawPart] || rawPart;
    if (STOP_WORDS.has(part) || part === '-') continue;

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

    if (part.includes('-')) {
      const subParts = part.split('-').filter(Boolean);
      for (const sp of subParts) {
        const normSp = SPELLING_NORMALIZER[sp] || sp;
        expanded.push(PLURAL_TO_SINGULAR[normSp] || normSp);
      }
    } else {
      expanded.push(PLURAL_TO_SINGULAR[part] || part);
    }
  }

  return expanded;
}

function extractNumericTokens(tokens: string[]): string[] {
  return tokens.filter((t) => /\d/.test(t));
}

const UNIT_SUFFIX_RE =
  /(?:sqmm|micron|lph|ltr|gsm|cum|ply|ton|mm|kg|kw|hp|gb|l|w|a|v)$/i;

function hasNumericConflict(qNums: string[], iNums: string[]): boolean {
  if (qNums.length === 0 || iNums.length === 0) return false;
  for (const qn of qNums) {
    const qBase = qn.replace(UNIT_SUFFIX_RE, '');
    const matched = iNums.some((inm) => {
      const iBase = inm.replace(UNIT_SUFFIX_RE, '');
      return inm === qn || (qBase.length > 0 && iBase === qBase);
    });
    if (!matched) {
      return true;
    }
  }
  return false;
}

/**
 * Bounded Levenshtein distance <= 1 for pure alphabetic words of length >= 5
 * (handles minor human typos like "nitrile glovs" or "ball bearning", never touches part numbers).
 */
function isAlphaTypoMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (!/^[a-z]+$/.test(a) || !/^[a-z]+$/.test(b)) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else {
      edits++;
      if (edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else {
        i++;
        j++;
      }
    }
  }
  if (i < a.length || j < b.length) edits++;
  return edits <= 1;
}

export function findCatalogCandidates(
  rawDescription: string,
  catalog: Map<string, Item>,
  limit = 5
): CatalogCandidate[] {
  const { cleaned } = stripOperationalNoise(rawDescription);
  const qTokens = normalizeTokens(cleaned);
  if (qTokens.length === 0) return [];

  const qSet = new Set(qTokens);
  const qNums = extractNumericTokens(qTokens);
  const scored: CatalogCandidate[] = [];

  for (const [code, item] of catalog.entries()) {
    const iTokens = normalizeTokens(item.description);
    const iSet = new Set(iTokens);
    const iNums = extractNumericTokens(iTokens);

    if (hasNumericConflict(qNums, iNums)) continue;

    let overlap = 0;
    for (const qt of qSet) {
      if (iSet.has(qt)) {
        overlap++;
      } else {
        for (const it of iSet) {
          if (isAlphaTypoMatch(qt, it)) {
            overlap++;
            break;
          }
        }
      }
    }
    if (overlap === 0) continue;

    const maxLen = Math.max(qSet.size, iSet.size);
    const score = overlap / maxLen;
    const query_coverage = overlap / qSet.size;
    scored.push({
      item_code: code,
      description: item.description,
      score,
      query_coverage
    });
  }

  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.query_coverage - a.query_coverage ||
        a.item_code.localeCompare(b.item_code)
    )
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
  const qTokenCount = new Set(normalizeTokens(cleaned)).size;
  const candidates = findCatalogCandidates(cleaned, catalog, 5);
  if (candidates.length > 0) {
    const best = candidates[0];
    const second = candidates[1];

    const strongOverlap = best.score >= 0.55;
    // Unambiguous subset match: >=2 query tokens, 100% of query tokens present in item,
    // and clearly ahead of any runner-up (handles "safety shoes", "a4 paper", "cnc turning center")
    const unambiguousSubset =
      qTokenCount >= 2 &&
      best.query_coverage === 1.0 &&
      best.score >= 0.4 &&
      (!second || best.score - second.score >= 0.15 || best.query_coverage - second.query_coverage >= 0.25);

    if (strongOverlap || unambiguousSubset) {
      return {
        resolved_item_code: best.item_code,
        is_new: false,
        match_confidence: Number(Math.max(best.score, unambiguousSubset ? 0.85 : best.score).toFixed(3)),
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
