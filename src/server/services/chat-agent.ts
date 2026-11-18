import { z } from 'zod';
import { Item, Plant, Urgency } from '../../engine/types.js';
import { findCatalogCandidates, resolveItem } from '../../engine/item-resolver.js';
import { groqClient } from './groq-client.js';

export interface ChatSlots {
  item_query: string | null;
  resolved_item_code: string | null; // 'ITM-XXXX' | 'NEW' | null
  item_description: string | null;
  uom: string | null;
  item_match_status: 'UNSET' | 'MATCHED' | 'AMBIGUOUS' | 'NEW_ITEM';
  candidate_items: Array<{ item_code: string; description: string; uom: string; score: number }>;
  quantity: number | null;
  plant: string | null;
  need_by_date: string | null; // YYYY-MM-DD
  urgency: Urgency | null;
  estimated_unit_price: number | null;
  requester: string;
  department: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatTurnResponse {
  session_id: string;
  reply: string;
  slots: ChatSlots;
  missing_slots: string[];
  ready_to_confirm: boolean;
  used_ai: boolean;
  candidate_items: Array<{ item_code: string; description: string; uom: string; score: number }>;
  quick_replies: string[];
}

const GroqSlotExtractionSchema = z.object({
  item_query: z.string().nullable().optional(),
  explicit_item_code: z.string().nullable().optional(),
  confirm_new_item: z.boolean().nullable().optional(),
  quantity: z.number().nullable().optional(),
  plant: z.string().nullable().optional(),
  need_by_date: z.string().nullable().optional(),
  urgency: z.enum(['Normal', 'Emergency']).nullable().optional(),
  estimated_unit_price: z.number().nullable().optional(),
  requester: z.string().nullable().optional(),
  department: z.string().nullable().optional()
});

export function createInitialSlots(): ChatSlots {
  return {
    item_query: null,
    resolved_item_code: null,
    item_description: null,
    uom: null,
    item_match_status: 'UNSET',
    candidate_items: [],
    quantity: null,
    plant: null,
    need_by_date: null,
    urgency: null,
    estimated_unit_price: null,
    requester: 'Shop-Floor Requester',
    department: 'Production'
  };
}

/**
 * Deterministic relative date helper (e.g. "next Friday", "tomorrow", "in 5 days", "2026-11-28", "28 Nov").
 */
export function resolveRelativeDate(text: string, referenceDateIso: string): string | null {
  const lower = text.toLowerCase();

  // Explicit ISO YYYY-MM-DD
  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (dmyMatch) {
    const dd = dmyMatch[1].padStart(2, '0');
    const mm = dmyMatch[2].padStart(2, '0');
    return `${dmyMatch[3]}-${mm}-${dd}`;
  }

  // "28 Nov" or "Nov 28"
  const months: Record<string, string> = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
    apr: '04', april: '04', may: '05', jun: '06', june: '06', jul: '07', july: '07',
    aug: '08', august: '08', sep: '09', sept: '09', september: '09',
    oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12'
  };
  const refParts = referenceDateIso.split('-').map(Number);
  const baseDate = new Date(Date.UTC(refParts[0], refParts[1] - 1, refParts[2]));

  const dayMon = lower.match(/\b(\d{1,2})\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(?:\s+(\d{4}))?\b/);
  if (dayMon) {
    const dd = dayMon[1].padStart(2, '0');
    const mm = months[dayMon[2]];
    const yyyy = dayMon[3] || String(refParts[0]);
    return `${yyyy}-${mm}-${dd}`;
  }

  const monDay = lower.match(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:(?:,)?\s+(\d{4}))?\b/);
  if (monDay) {
    const mm = months[monDay[1]];
    const dd = monDay[2].padStart(2, '0');
    const yyyy = monDay[3] || String(refParts[0]);
    return `${yyyy}-${mm}-${dd}`;
  }

  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(baseDate.getTime() + 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  if (/\btoday\b/.test(lower)) {
    return referenceDateIso;
  }

  const inDays = lower.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays) {
    const d = new Date(baseDate.getTime() + Number(inDays[1]) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  const inWeeks = lower.match(/\bin\s+(\d+)\s+weeks?\b/);
  if (inWeeks) {
    const d = new Date(baseDate.getTime() + Number(inWeeks[1]) * 7 * 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  if (/\bnext\s+week\b/.test(lower)) {
    const d = new Date(baseDate.getTime() + 7 * 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const wdMatch = lower.match(/\b(next|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wdMatch) {
    const modifier = wdMatch[1];
    const targetDay = weekdays.indexOf(wdMatch[2]);
    const currentDay = baseDate.getUTCDay();
    let delta = (targetDay - currentDay + 7) % 7;
    if (delta === 0) delta = 7;
    if (modifier === 'next' && delta <= 2) delta += 7;
    const d = new Date(baseDate.getTime() + delta * 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  return null;
}

function normalizePlant(raw: string | null | undefined, plants: Map<string, Plant>): string | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (lower === 'pun1' || lower.includes('bhosari') || lower === 'pune') return 'PUN1';
  if (lower === 'chk1' || lower.includes('chakan')) return 'CHK1';
  const upper = raw.trim().toUpperCase();
  return plants.has(upper) ? upper : null;
}

/**
 * Deterministic regex/heuristic slot extractor (used when GROQ_API_KEY is absent or as safety net).
 */
const GREETING_OR_CHITCHAT =
  /^(?:hi+|hello|hey)(?:\s+there|\s+bot|\s+assistant)?[!?.]*$|^(?:good\s*(?:morning|afternoon|evening)(?:\s+\w+)?|help|start|menu|thanks?|thank\s+you|ok|okay|sure|namaste|how\s+are\s+you|what\s+can\s+you\s+do)[!?.]*$/i;

function extractSlotsDeterministic(
  message: string,
  currentSlots: ChatSlots,
  plants: Map<string, Plant>,
  referenceDateIso: string
): z.infer<typeof GroqSlotExtractionSchema> & { validation_notes: string[] } {
  const out: z.infer<typeof GroqSlotExtractionSchema> & { validation_notes: string[] } = {
    validation_notes: []
  };
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  // Never treat greetings or help messages as a purchase item
  if (GREETING_OR_CHITCHAT.test(trimmed)) {
    return out;
  }

  // Explicit item code like ITM-1048
  const codeMatch = trimmed.match(/\b(ITM-\d{4})\b/i);
  if (codeMatch) {
    out.explicit_item_code = codeMatch[1].toUpperCase();
  }

  // Confirm new item
  if (/\b(new\s*item|none\s+of\s+these|treat\s+as\s+new|not\s+in\s+catalog)\b/i.test(lower)) {
    out.confirm_new_item = true;
  }

  // Plant detection (including explicit feedback for invalid plant codes like PUN2)
  if (/\b(chk1|chakan)\b/i.test(lower)) {
    out.plant = 'CHK1';
  } else if (/\b(pun1|bhosari)\b/i.test(lower)) {
    out.plant = 'PUN1';
  } else {
    const unknownPlant = trimmed.match(/\b((?:PUN|CHK|MUM|BLR|DEL)\d+)\b/i);
    if (unknownPlant && !plants.has(unknownPlant[1].toUpperCase())) {
      out.validation_notes.push(
        `Note: "${unknownPlant[1].toUpperCase()}" is not a valid Corvo plant. Please choose PUN1 (Bhosari) or CHK1 (Chakan).`
      );
    }
  }

  // Detect invalid non-positive quantities explicitly (both inline and standalone like "-50" or "0")
  const standaloneNonPos = trimmed.match(/^\s*(-?\d+(?:\.\d+)?)\s*$/);
  const inlineNonPos = trimmed.match(
    /\b(?:need|want|order|qty|quantity|change(?:\s+qty|\s+quantity)?|make\s+it)\s+(?:to\s+)?(-?\d+(?:\.\d+)?)\b/i
  );
  if (standaloneNonPos && Number(standaloneNonPos[1]) <= 0) {
    out.validation_notes.push(
      `Note: Quantity must be greater than 0 (received ${standaloneNonPos[1]}).`
    );
  } else if (inlineNonPos && Number(inlineNonPos[1]) <= 0) {
    out.validation_notes.push(
      `Note: Quantity must be greater than 0 (received ${inlineNonPos[1]}).`
    );
  }

  // Urgency detection
  if (/\b(emergency|urgent|breakdown|critical)\b/i.test(lower)) {
    out.urgency = 'Emergency';
  } else if (/\b(normal|regular|standard|routine)\b/i.test(lower)) {
    out.urgency = 'Normal';
  }

  // Date detection
  const dateVal = resolveRelativeDate(trimmed, referenceDateIso);
  if (dateVal) out.need_by_date = dateVal;

  // Price detection (INR / Rs / ₹ / "estimated price 5000" / "price is 5000")
  const priceMatch =
    trimmed.match(/(?:₹|\brs\.?|\binr)\s*(\d[\d,]*(?:\.\d+)?)/i) ||
    trimmed.match(/(?:estimate(?:d)?|price|cost|rate)\s*(?:is|of|around|approx\.?|:)?\s*(\d[\d,]*(?:\.\d+)?)/i);
  if (priceMatch) {
    const val = Number(priceMatch[1].replace(/,/g, ''));
    if (Number.isFinite(val) && val > 0) out.estimated_unit_price = val;
  } else if (
    currentSlots.item_match_status === 'NEW_ITEM' &&
    currentSlots.estimated_unit_price === null &&
    currentSlots.quantity !== null &&
    /^\s*[\d,]+(?:\.\d+)?\s*$/.test(trimmed)
  ) {
    const val = Number(trimmed.replace(/,/g, ''));
    if (Number.isFinite(val) && val > 0) out.estimated_unit_price = val;
  }

  // Quantity detection (supports initial requests AND multi-turn edits like "actually change qty to 500" / "make it 300")
  if (
    currentSlots.quantity === null &&
    /^\s*(\d+(?:\.\d+)?)\s*(?:nos|kg|ltr|mtr|pairs?|sets?|cyl|rol|reams?|jobs?|pcs|units?)?\s*$/i.test(trimmed)
  ) {
    const q = Number(trimmed.match(/\d+(?:\.\d+)?/)![0]);
    if (q > 0) out.quantity = q;
  } else {
    const qtyMatch =
      trimmed.match(
        /\b(?:change(?:\s+(?:the\s+)?(?:qty|quantity))?|update(?:\s+(?:the\s+)?(?:qty|quantity))?|set(?:\s+(?:the\s+)?(?:qty|quantity))?|make\s+it|qty|quantity)\s+(?:to\s+|=\s*)?(\d+(?:\.\d+)?)\b/i
      ) ||
      trimmed.match(/\b(?:need|want|order|buy|request)\s+(?:about\s+)?(\d+(?:\.\d+)?)\b/i) ||
      trimmed.match(/\b(\d+(?:\.\d+)?)\s+(?:nos|kg|ltr|mtr|pairs?|sets?|cyl|rol|reams?|jobs?|pcs|units?)\b/i) ||
      (currentSlots.quantity === null
        ? trimmed.match(
            /^\s*(\d+(?:\.\d+)?)(?=\s*(?:,|for\b|at\b|to\b|by\b|normal\b|emergency\b))/i
          )
        : null);
    if (qtyMatch) {
      const q = Number(qtyMatch[1]);
      if (Number.isFinite(q) && q > 0) out.quantity = q;
    }
  }

  // Item query extraction if item not yet matched and message looks like an item request
  if (!out.explicit_item_code && !out.confirm_new_item && currentSlots.item_match_status !== 'MATCHED') {
    const isShortSlotAnswer =
      /^(normal|emergency|pun1|chk1|bhosari|chakan|yes|no|confirm|-?\d+(?:\.\d+)?)$/i.test(trimmed) ||
      (out.need_by_date !== undefined && trimmed.split(/\s+/).length <= 3) ||
      (out.estimated_unit_price !== undefined && trimmed.split(/\s+/).length <= 4) ||
      Boolean(standaloneNonPos);

    if (!isShortSlotAnswer) {
      const cleaned = trimmed
        .replace(/^(?:i\s+)?(?:need|want|require|please\s+order|order|buy|raise\s+a?\s*pr\s+for)\s+/i, '')
        .replace(/\b-?\d+(?:\.\d+)?\s+(?:nos|kg|ltr|mtr|pairs?|sets?|cyl|rol|reams?|jobs?|pcs|units?)\s+(?:of\s+)?/i, '')
        .replace(/^-?\d+(?:\.\d+)?\s+/, '')
        .replace(/\b(?:for|at|to)\s+(?:chakan|bhosari|chk1|pun1|(?:pun|chk|mum|blr|del)\d+)(?:\s+plant)?\b/gi, '')
        .replace(
          /\b(?:by|before|on)\s+(?:next\s+\w+|this\s+\w+|tomorrow|today|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(?:\s+\d{4})?|(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:,?\s+\d{4})?)\b/gi,
          ''
        )
        .replace(/\b(?:normal|emergency|urgent|routine)\s*(?:priority|urgency|request)?\b/gi, '')
        .replace(/(?:₹|\brs\.?|\binr)\s*\d[\d,]*(?:\.\d+)?/gi, '')
        .replace(/[,.;]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Reject pure numbers / symbols as item names
      if (cleaned.length >= 2 && /[a-z]/i.test(cleaned)) {
        out.item_query = cleaned;
      }
    }
  }

  // Validate plant via map
  if (out.plant) {
    out.plant = normalizePlant(out.plant, plants);
  }

  return out;
}

/**
 * Deterministic Anti-Hallucination Item Resolver for Chat Intake.
 * NEVER invents item codes; clearly distinguishes MATCHED, AMBIGUOUS (vague), and NEW_ITEM.
 */
export function resolveChatItemDeterministically(
  itemQuery: string | null,
  explicitItemCode: string | null,
  confirmNewItem: boolean,
  catalog: Map<string, Item>
): {
  status: ChatSlots['item_match_status'];
  resolved_item_code: string | null;
  item_description: string | null;
  uom: string | null;
  candidates: Array<{ item_code: string; description: string; uom: string; score: number }>;
} {
  // 1. User explicitly chose "None of these / New item"
  if (confirmNewItem) {
    return {
      status: 'NEW_ITEM',
      resolved_item_code: 'NEW',
      item_description: itemQuery || 'Custom Uncataloged Item',
      uom: 'NOS',
      candidates: []
    };
  }

  // 2. Explicit valid catalog item code selected/typed
  if (explicitItemCode && catalog.has(explicitItemCode.trim().toUpperCase())) {
    const item = catalog.get(explicitItemCode.trim().toUpperCase())!;
    return {
      status: 'MATCHED',
      resolved_item_code: item.item_code,
      item_description: item.description,
      uom: item.uom,
      candidates: []
    };
  }

  if (!itemQuery || !itemQuery.trim()) {
    return {
      status: 'UNSET',
      resolved_item_code: null,
      item_description: null,
      uom: null,
      candidates: []
    };
  }

  // 3. Exact code or exact normalized description match
  const direct = resolveItem(null, itemQuery, catalog);
  if (!direct.is_new && direct.match_confidence >= 0.99) {
    const item = catalog.get(direct.resolved_item_code)!;
    return {
      status: 'MATCHED',
      resolved_item_code: item.item_code,
      item_description: item.description,
      uom: item.uom,
      candidates: []
    };
  }

  // 4. Ranked candidates check for confident match vs vague/ambiguous vs novel NEW item
  const rawCandidates = findCatalogCandidates(itemQuery, catalog, 5);
  const enrichedCandidates = rawCandidates.map((c) => {
    const item = catalog.get(c.item_code)!;
    return {
      item_code: c.item_code,
      description: item.description,
      uom: item.uom,
      score: Number(c.score.toFixed(3))
    };
  });

  if (enrichedCandidates.length > 0) {
    const top = enrichedCandidates[0];
    const second = enrichedCandidates[1];
    const gap = second ? top.score - second.score : top.score;
    const topCov = rawCandidates[0].query_coverage;
    const secondCov = rawCandidates[1]?.query_coverage ?? 0;

    // Confident match: strong overlap OR unambiguous 100%-contained multi-token subset (e.g. "safety shoes", "a4 paper")
    const isConfidentOverlap = top.score >= 0.6 && (!second || gap >= 0.18);
    const isUnambiguousSubset =
      itemQuery.trim().split(/\s+/).length >= 2 &&
      topCov === 1.0 &&
      top.score >= 0.4 &&
      (!second || gap >= 0.15 || topCov - secondCov >= 0.25);

    if (isConfidentOverlap || isUnambiguousSubset) {
      const item = catalog.get(top.item_code)!;
      return {
        status: 'MATCHED',
        resolved_item_code: item.item_code,
        item_description: item.description,
        uom: item.uom,
        candidates: []
      };
    }

    // Ambiguous / vague query (e.g. "gloves", "bearings", "hex bolt", "ms sheet")
    const plausible = enrichedCandidates.filter((c) => c.score >= 0.2);
    if (plausible.length > 0) {
      return {
        status: 'AMBIGUOUS',
        resolved_item_code: null,
        item_description: null,
        uom: null,
        candidates: plausible
      };
    }
  }

  // 5. Completely uncataloged -> NEW item (Clause 1.2)
  return {
    status: 'NEW_ITEM',
    resolved_item_code: 'NEW',
    item_description: itemQuery.trim(),
    uom: 'NOS',
    candidates: []
  };
}

export function computeMissingSlots(slots: ChatSlots): string[] {
  const missing: string[] = [];
  if (slots.item_match_status === 'UNSET' || slots.item_match_status === 'AMBIGUOUS') {
    missing.push('item');
  }
  if (!slots.quantity || slots.quantity <= 0) {
    missing.push('quantity');
  }
  if (!slots.plant) {
    missing.push('plant');
  }
  if (!slots.need_by_date) {
    missing.push('need_by_date');
  }
  if (!slots.urgency) {
    missing.push('urgency');
  }
  if (
    slots.item_match_status === 'NEW_ITEM' &&
    (!slots.estimated_unit_price || slots.estimated_unit_price <= 0)
  ) {
    missing.push('estimated_unit_price');
  }
  return missing;
}

function buildDeterministicReply(
  slots: ChatSlots,
  missing: string[]
): { reply: string; quick_replies: string[] } {
  // 1. Ambiguous item -> ask user to disambiguate
  if (slots.item_match_status === 'AMBIGUOUS' && slots.candidate_items.length > 0) {
    const listText = slots.candidate_items
      .map((c) => `• ${c.item_code}: ${c.description} (${c.uom})`)
      .join('\n');
    return {
      reply: `I found multiple matching items for "${slots.item_query}". Which one do you need?\n${listText}\nOr choose "New item" if none of these match.`,
      quick_replies: [
        ...slots.candidate_items.slice(0, 4).map((c) => `${c.item_code} - ${c.description}`),
        'None of these — treat as new item'
      ]
    };
  }

  // 2. All required slots filled -> Confirmation summary!
  if (missing.length === 0) {
    const plantLabel = slots.plant === 'CHK1' ? 'CHK1 (Chakan)' : 'PUN1 (Bhosari)';
    const itemLabel =
      slots.resolved_item_code === 'NEW'
        ? `NEW ITEM: ${slots.item_description} (Est. ₹${slots.estimated_unit_price?.toLocaleString('en-IN')}/${slots.uom})`
        : `${slots.resolved_item_code} — ${slots.item_description}`;

    return {
      reply: `Got it! Here is your Purchase Requisition summary:\n• Item: ${itemLabel}\n• Quantity: ${slots.quantity} ${slots.uom || 'NOS'}\n• Plant: ${plantLabel}\n• Need-by Date: ${slots.need_by_date}\n• Urgency: ${slots.urgency}\n\nPlease review the confirmation card below and click **Confirm & Create PR** (or tell me if you want to change anything).`,
      quick_replies: []
    };
  }

  // 3. Build natural acknowledgement + ask specifically for missing slots
  const ackParts: string[] = [];
  if (slots.item_match_status === 'MATCHED') {
    ackParts.push(`Matched **${slots.resolved_item_code}** (${slots.item_description})`);
  } else if (slots.item_match_status === 'NEW_ITEM') {
    ackParts.push(
      `"${slots.item_description}" is not in Corvo's item catalog, so I'll raise it as a **New Item** sourcing request (Policy Clause 1.2)`
    );
  }
  if (slots.quantity) ackParts.push(`Qty: ${slots.quantity} ${slots.uom || 'NOS'}`);
  if (slots.plant) ackParts.push(`Plant: ${slots.plant}`);
  if (slots.need_by_date) ackParts.push(`Need-by: ${slots.need_by_date}`);
  if (slots.urgency) ackParts.push(`Urgency: ${slots.urgency}`);

  const questions: string[] = [];
  const quickReplies: string[] = [];

  if (missing.includes('item')) {
    questions.push('Which item do you want to purchase (item code or description)?');
  }
  if (missing.includes('quantity')) {
    questions.push(`What quantity (${slots.uom || 'units'}) do you need?`);
  }
  if (missing.includes('plant')) {
    questions.push('Which delivery plant is this for — **PUN1 (Bhosari)** or **CHK1 (Chakan)**?');
    if (quickReplies.length === 0) quickReplies.push('PUN1 (Bhosari)', 'CHK1 (Chakan)');
  }
  if (missing.includes('need_by_date')) {
    questions.push('What is the **need-by date** (e.g., "next Friday" or "2026-11-28")?');
  }
  if (missing.includes('urgency')) {
    questions.push('Is this **Normal** or **Emergency** urgency?');
    if (quickReplies.length === 0) quickReplies.push('Normal', 'Emergency');
  }
  if (missing.includes('estimated_unit_price')) {
    questions.push('Since this is a new uncataloged item, what is the **estimated unit price in INR**?');
  }

  const prefix = ackParts.length > 0 ? `${ackParts.join(' · ')}.\n\n` : '';
  const askText =
    questions.length === 1
      ? questions[0]
      : `Could you please provide the remaining details?\n${questions.map((q) => `• ${q}`).join('\n')}`;

  return {
    reply: `${prefix}${askText}`,
    quick_replies: quickReplies
  };
}

export async function processChatMessage(opts: {
  sessionId: string;
  userMessage: string;
  currentSlots: ChatSlots;
  history: ChatMessage[];
  items: Map<string, Item>;
  plants: Map<string, Plant>;
  referenceDateIso?: string;
}): Promise<ChatTurnResponse> {
  const refDate = opts.referenceDateIso || new Date().toISOString().slice(0, 10);
  const slots: ChatSlots = {
    ...opts.currentSlots,
    candidate_items: [...opts.currentSlots.candidate_items]
  };

  let usedAi = false;
  let extracted: z.infer<typeof GroqSlotExtractionSchema> | null = null;

  // Step 1: Try Groq structured slot extraction (NEVER lets LLM invent catalog codes!)
  const isGreeting = GREETING_OR_CHITCHAT.test(opts.userMessage.trim());
  if (!isGreeting && groqClient.isConfigured()) {
    const systemPrompt = `You are a procurement intake slot extractor for Corvo Engineering (plants: PUN1 = Bhosari, CHK1 = Chakan).
Today's reference date is ${refDate}.
Extract ONLY facts explicitly stated or clearly updated in the user's latest message (given conversation context).
CRITICAL RULES:
- NEVER invent or guess catalog item codes (ITM-XXXX). Only set explicit_item_code if the user literally wrote ITM-XXXX in their message.
- NEVER assume urgency unless the user explicitly mentions Normal/Regular/Routine or Emergency/Urgent/Breakdown.
- Resolve relative dates like "next Friday", "tomorrow", "in 10 days" into exact YYYY-MM-DD relative to ${refDate}.
- Map "Chakan" -> "CHK1" and "Bhosari" -> "PUN1".
- If the user says "none of these" or "new item", set confirm_new_item: true.
Return ONLY a JSON object with keys:
{ "item_query": string|null, "explicit_item_code": string|null, "confirm_new_item": boolean|null, "quantity": number|null, "plant": "PUN1"|"CHK1"|null, "need_by_date": "YYYY-MM-DD"|null, "urgency": "Normal"|"Emergency"|null, "estimated_unit_price": number|null, "requester": string|null, "department": string|null }`;

    const recentHistory = opts.history
      .slice(-6)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const userPrompt = `Current slots: ${JSON.stringify({
      item_query: slots.item_query,
      resolved_item_code: slots.resolved_item_code,
      item_match_status: slots.item_match_status,
      quantity: slots.quantity,
      plant: slots.plant,
      need_by_date: slots.need_by_date,
      urgency: slots.urgency,
      estimated_unit_price: slots.estimated_unit_price
    })}
Recent conversation:
${recentHistory}
Latest user message: "${opts.userMessage}"`;

    const aiRes = await groqClient.completeJson(systemPrompt, userPrompt, GroqSlotExtractionSchema);
    if (aiRes.ok && aiRes.data) {
      extracted = aiRes.data;
      usedAi = true;
    }
  }

  // Step 2: Deterministic fallback / merge
  const det = extractSlotsDeterministic(opts.userMessage, slots, opts.plants, refDate);
  const merged = {
    item_query: extracted?.item_query ?? det.item_query ?? null,
    explicit_item_code: det.explicit_item_code ?? extracted?.explicit_item_code ?? null,
    confirm_new_item: Boolean(extracted?.confirm_new_item || det.confirm_new_item),
    quantity: extracted?.quantity ?? det.quantity ?? null,
    plant: normalizePlant(extracted?.plant ?? det.plant, opts.plants),
    need_by_date:
      extracted?.need_by_date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.need_by_date)
        ? extracted.need_by_date
        : det.need_by_date ?? null,
    urgency: extracted?.urgency ?? det.urgency ?? null,
    estimated_unit_price: extracted?.estimated_unit_price ?? det.estimated_unit_price ?? null,
    requester: extracted?.requester ?? null,
    department: extracted?.department ?? null
  };

  // Step 3: Apply validated non-null slot updates
  if (merged.quantity !== null && merged.quantity > 0) slots.quantity = merged.quantity;
  if (merged.plant) slots.plant = merged.plant;
  if (merged.need_by_date) slots.need_by_date = merged.need_by_date;
  if (merged.urgency) slots.urgency = merged.urgency;
  if (merged.estimated_unit_price !== null && merged.estimated_unit_price > 0) {
    slots.estimated_unit_price = merged.estimated_unit_price;
  }
  if (merged.requester) slots.requester = merged.requester;
  if (merged.department) slots.department = merged.department;

  // Step 4: Deterministic item resolution (strictly enforces anti-hallucination!)
  const shouldResolveItem =
    merged.confirm_new_item ||
    Boolean(merged.explicit_item_code) ||
    (Boolean(merged.item_query) &&
      (slots.item_match_status !== 'MATCHED' ||
        merged.item_query!.toLowerCase() !== (slots.item_query || '').toLowerCase()));

  if (shouldResolveItem) {
    if (merged.item_query && !merged.confirm_new_item) {
      slots.item_query = merged.item_query;
    }
    const itemMatch = resolveChatItemDeterministically(
      slots.item_query || merged.item_query,
      merged.explicit_item_code,
      merged.confirm_new_item,
      opts.items
    );
    slots.item_match_status = itemMatch.status;
    slots.resolved_item_code = itemMatch.resolved_item_code;
    slots.item_description = itemMatch.item_description;
    slots.uom = itemMatch.uom;
    slots.candidate_items = itemMatch.candidates;
  }

  // Step 5: Compute remaining missing slots & natural reply
  const missing = computeMissingSlots(slots);
  const { reply: baseReply, quick_replies } = buildDeterministicReply(slots, missing);
  const reply = isGreeting && slots.item_match_status === 'UNSET'
    ? 'Hello! Tell me what item you need to purchase along with quantity, plant (PUN1 Bhosari or CHK1 Chakan), need-by date, and urgency — for example: "need 200 nitrile gloves for Chakan by next Friday".'
    : det.validation_notes.length > 0
      ? `${det.validation_notes.join('\n')}\n\n${baseReply}`
      : baseReply;

  return {
    session_id: opts.sessionId,
    reply,
    slots,
    missing_slots: missing,
    ready_to_confirm: missing.length === 0,
    used_ai: usedAi,
    candidate_items: slots.candidate_items,
    quick_replies
  };
}
