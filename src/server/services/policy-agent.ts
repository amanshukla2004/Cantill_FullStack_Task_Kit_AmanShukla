import { z } from 'zod';
import { Policy, PolicyRule } from '../../engine/types.js';
import { PolicyRuleSchema } from '../../engine/policy-ast.js';
import { groqClient } from './groq-client.js';
import { parseInrNumber } from './pdf-extractor.js';

export const PolicyAmendmentDraftSchema = z.object({
  new_version: z.string().min(1),
  title: z.string().min(1),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clubbing_creation_window_days: z.number().int().min(0).default(14),
  clubbing_need_by_window_days: z.number().int().min(0).default(7),
  po_consolidation_window_hours: z.number().int().min(0).default(24),
  active_history_lookback_days: z.number().int().min(1).default(365),
  psl_lookback_days: z.number().int().min(1).default(548),
  psl_recency_high_days: z.number().int().min(1).default(90),
  psl_recency_med_days: z.number().int().min(1).default(365),
  rules: z.array(PolicyRuleSchema).min(1),
  plain_language_diff: z.array(z.string()).default([])
});

export type PolicyAmendmentDraft = z.infer<typeof PolicyAmendmentDraftSchema>;

export interface StructuralDiffSummary {
  parameter_changes: string[];
  rules_added: string[];
  rules_modified: string[];
  rules_removed: string[];
  plain_language_summary: string[];
}

function formatRuleBrief(r: PolicyRule): string {
  return `Clause ${r.clause_number} [P${r.priority_order}] "${r.rule_name}" -> ${r.outcome} (${r.route}, ${r.supplier_strategy}${r.supplier_suggestion_count > 0 ? `, suggest ${r.supplier_suggestion_count}` : ''}) WHEN ${JSON.stringify(r.conditions)}`;
}

/**
 * Computes an exact deterministic diff between the current active Policy and a proposed draft
 * so the buyer always sees what will genuinely change in the execution engine.
 */
export function computePolicyDiff(
  current: Policy,
  draft: PolicyAmendmentDraft
): StructuralDiffSummary {
  const parameter_changes: string[] = [];
  const rules_added: string[] = [];
  const rules_modified: string[] = [];
  const rules_removed: string[] = [];

  const paramChecks: Array<[keyof PolicyAmendmentDraft, keyof Policy, string]> = [
    ['effective_date', 'effective_date', 'Effective date'],
    ['clubbing_creation_window_days', 'clubbing_creation_window_days', 'Clubbing creation window (days)'],
    ['clubbing_need_by_window_days', 'clubbing_need_by_window_days', 'Clubbing need-by window (days)'],
    ['po_consolidation_window_hours', 'po_consolidation_window_hours', 'PO consolidation window (hours)'],
    ['active_history_lookback_days', 'active_history_lookback_days', 'Active purchase history lookback (days)'],
    ['psl_lookback_days', 'psl_lookback_days', 'Preferred supplier lookback (days)']
  ];

  for (const [draftKey, curKey, label] of paramChecks) {
    const oldVal = current[curKey];
    const newVal = draft[draftKey];
    if (oldVal !== newVal) {
      parameter_changes.push(`${label}: ${oldVal} -> ${newVal}`);
    }
  }

  const oldByClause = new Map(current.rules.map((r) => [r.clause_number, r]));
  const newByClause = new Map(draft.rules.map((r) => [r.clause_number, r]));

  for (const newRule of draft.rules) {
    const oldRule = oldByClause.get(newRule.clause_number);
    if (!oldRule) {
      rules_added.push(`NEW ${formatRuleBrief(newRule)}`);
    } else {
      const oldSig = JSON.stringify({
        priority_order: oldRule.priority_order,
        conditions: oldRule.conditions,
        outcome: oldRule.outcome,
        route: oldRule.route,
        supplier_strategy: oldRule.supplier_strategy,
        supplier_suggestion_count: oldRule.supplier_suggestion_count
      });
      const newSig = JSON.stringify({
        priority_order: newRule.priority_order,
        conditions: newRule.conditions,
        outcome: newRule.outcome,
        route: newRule.route,
        supplier_strategy: newRule.supplier_strategy,
        supplier_suggestion_count: newRule.supplier_suggestion_count
      });
      if (oldSig !== newSig) {
        rules_modified.push(
          `CHANGED Clause ${newRule.clause_number} (${newRule.rule_name}): ${JSON.stringify(oldRule.conditions)} [${oldRule.route}, P${oldRule.priority_order}] -> ${JSON.stringify(newRule.conditions)} [${newRule.route}, P${newRule.priority_order}]`
        );
      }
    }
  }

  for (const oldRule of current.rules) {
    if (!newByClause.has(oldRule.clause_number)) {
      rules_removed.push(`REMOVED Clause ${oldRule.clause_number} (${oldRule.rule_name})`);
    }
  }

  const plain_language_summary = [
    ...(draft.plain_language_diff || []),
    ...parameter_changes,
    ...rules_added,
    ...rules_modified,
    ...rules_removed
  ];

  // Deduplicate exact strings
  const uniqueSummary = Array.from(new Set(plain_language_summary));

  return {
    parameter_changes,
    rules_added,
    rules_modified,
    rules_removed,
    plain_language_summary: uniqueSummary
  };
}

function bumpMinorVersion(ver: string): string {
  const parts = ver.replace(/^v/i, '').split('.');
  if (parts.length >= 2 && Number.isFinite(Number(parts[1]))) {
    return `${parts[0]}.${Number(parts[1]) + 1}`;
  }
  return `${ver}.1`;
}

function parseIndianAmount(text: string): number | null {
  const lakhMatch = text.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*lakh/i);
  if (lakhMatch) return Math.round(Number(lakhMatch[1]) * 100000);
  const numMatch = text.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i);
  if (numMatch) {
    const val = parseInrNumber(numMatch[1]);
    return val > 0 ? val : null;
  }
  return null;
}

/**
 * Deterministic regex fallback for common policy amendments when GROQ_API_KEY is not configured.
 */
function parseAmendmentDeterministic(
  amendmentText: string,
  current: Policy,
  knownCategories: string[]
): PolicyAmendmentDraft {
  const draft: PolicyAmendmentDraft = {
    new_version: bumpMinorVersion(current.version),
    title: `Corvo Engineering Procurement Policy v${bumpMinorVersion(current.version)}`,
    effective_date: new Date().toISOString().slice(0, 10),
    clubbing_creation_window_days: current.clubbing_creation_window_days,
    clubbing_need_by_window_days: current.clubbing_need_by_window_days,
    po_consolidation_window_hours: current.po_consolidation_window_hours,
    active_history_lookback_days: current.active_history_lookback_days,
    psl_lookback_days: current.psl_lookback_days,
    psl_recency_high_days: current.psl_recency_high_days,
    psl_recency_med_days: current.psl_recency_med_days,
    rules: current.rules.map((r) => ({
      ...r,
      conditions: JSON.parse(JSON.stringify(r.conditions))
    })),
    plain_language_diff: []
  };

  // Extract version if mentioned (e.g. "Version 5.1" or "v6.0")
  const verMatch = amendmentText.match(/\b(?:version|v)\s*(\d+\.\d+(?:\.\d+)?)\b/i);
  if (verMatch) {
    draft.new_version = verMatch[1];
    draft.title = `Corvo Engineering Procurement Policy v${verMatch[1]}`;
  }

  // Extract effective date (supports YYYY-MM-DD and prose dates like "1 November 2026" / "19 Nov 2026")
  const isoDateMatch =
    amendmentText.match(/effective(?:\s+from|\s+date)?[:\s]+(\d{4}-\d{2}-\d{2})/i) ||
    amendmentText.match(/\b(202\d-\d{2}-\d{2})\b/);
  if (isoDateMatch) {
    draft.effective_date = isoDateMatch[1];
  } else {
    const months: Record<string, string> = {
      jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
      apr: '04', april: '04', may: '05', jun: '06', june: '06', jul: '07', july: '07',
      aug: '08', august: '08', sep: '09', sept: '09', september: '09',
      oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12'
    };
    const proseDate = amendmentText.match(
      /\b(\d{1,2})\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(202\d)\b/i
    );
    if (proseDate) {
      draft.effective_date = `${proseDate[3]}-${months[proseDate[2].toLowerCase()]}-${proseDate[1].padStart(2, '0')}`;
    }
  }

  // Check macro window changes
  const clubDays = amendmentText.match(/clubbing[^.\n]*?(\d+)\s*(?:calendar\s+)?days/i);
  if (clubDays) {
    draft.clubbing_creation_window_days = Number(clubDays[1]);
    draft.plain_language_diff.push(`Updated clubbing creation window to ${clubDays[1]} days`);
  }

  const consolHrs = amendmentText.match(/consolidation[^.\n]*?(\d+)\s*hours/i);
  if (consolHrs) {
    draft.po_consolidation_window_hours = Number(consolHrs[1]);
    draft.plain_language_diff.push(`Updated PO consolidation window to ${consolHrs[1]} hours`);
  }

  // Check plant-specific spot limit (e.g. "For Chakan (CHK1), spot PO limit is ₹3,00,000")
  const plantMention = /\b(chk1|chakan)\b/i.test(amendmentText)
    ? 'CHK1'
    : /\b(pun1|bhosari)\b/i.test(amendmentText)
      ? 'PUN1'
      : null;

  const matchedCategory = knownCategories.find((cat) =>
    amendmentText.toLowerCase().includes(cat.toLowerCase())
  );

  // Spot limit sentence
  const spotSentence = amendmentText.match(/[^\n.]*spot\s+po[^\n.]*/i)?.[0];
  if (spotSentence) {
    const amt = parseIndianAmount(spotSentence);
    if (amt) {
      if (plantMention || matchedCategory) {
        const extraConds: Array<{ field: 'plant' | 'category'; op: 'eq'; value: string }> = [];
        if (plantMention) extraConds.push({ field: 'plant', op: 'eq', value: plantMention });
        if (matchedCategory) extraConds.push({ field: 'category', op: 'eq', value: matchedCategory });

        // Check existing Clause 5.4 threshold so tightening a plant/category excludes it from Clause 5.4
        const r54 = draft.rules.find((r) => r.clause_number === '5.4');
        let baseSpotLimit = 200000;
        if (r54 && 'all' in r54.conditions && Array.isArray(r54.conditions.all)) {
          const valCond = r54.conditions.all.find(
            (c) => 'field' in c && c.field === 'group_value_inr'
          );
          if (valCond && 'value' in valCond && typeof valCond.value === 'number') {
            baseSpotLimit = valCond.value;
          }
          if (amt < baseSpotLimit) {
            if (plantMention) {
              r54.conditions.all.push({ field: 'plant', op: 'neq', value: plantMention });
            }
            if (matchedCategory) {
              r54.conditions.all.push({ field: 'category', op: 'neq', value: matchedCategory });
            }
          }
        }

        const newRule: PolicyRule = {
          clause_number: '5.4a',
          priority_order: 4,
          rule_name: `${plantMention || matchedCategory} Spot PO Override`,
          conditions: {
            all: [
              ...extraConds,
              { field: 'group_value_inr', op: 'lt', value: amt },
              { field: 'has_active_365d_history', op: 'eq', value: true }
            ]
          },
          outcome: 'PO',
          route: 'SPOT_PO',
          supplier_strategy: 'PREFERRED_RANK_1',
          supplier_suggestion_count: 0,
          notes: `Added rule from amendment (${plantMention || matchedCategory} Spot PO limit ₹${amt.toLocaleString('en-IN')})`
        };
        // Insert right before clause 5.4
        const idx54 = draft.rules.findIndex((r) => r.clause_number === '5.4');
        const insertAt = idx54 >= 0 ? idx54 : 3;
        draft.rules.splice(insertAt, 0, newRule);
        draft.rules.forEach((r, idx) => {
          r.priority_order = idx + 1;
        });
        draft.plain_language_diff.push(
          `Added Clause 5.4a: ${plantMention || matchedCategory} Spot PO limit set to ₹${amt.toLocaleString('en-IN')}${
            amt < baseSpotLimit
              ? ` (and excluded ${plantMention || matchedCategory} from generic Clause 5.4 ₹${baseSpotLimit.toLocaleString('en-IN')} limit)`
              : ''
          }`
        );
      } else {
        const r54 = draft.rules.find((r) => r.clause_number === '5.4');
        if (r54 && 'all' in r54.conditions && Array.isArray(r54.conditions.all)) {
          for (const c of r54.conditions.all) {
            if ('field' in c && c.field === 'group_value_inr') {
              c.value = amt;
            }
          }
          draft.plain_language_diff.push(
            `Updated Clause 5.4 Spot PO limit to ₹${amt.toLocaleString('en-IN')}`
          );
        }
      }
    }
  }

  // Emergency PO limit sentence
  const emergSentence = amendmentText.match(/[^\n.]*emergency\s+po[^\n.]*/i)?.[0];
  if (emergSentence) {
    const amt = parseIndianAmount(emergSentence);
    if (amt) {
      const r53 = draft.rules.find((r) => r.clause_number === '5.3');
      if (r53 && 'all' in r53.conditions && Array.isArray(r53.conditions.all)) {
        for (const c of r53.conditions.all) {
          if ('field' in c && c.field === 'group_value_inr') {
            c.value = amt;
          }
        }
        draft.plain_language_diff.push(
          `Updated Clause 5.3 Emergency PO limit to ₹${amt.toLocaleString('en-IN')}`
        );
      }
    }
  }

  // RFP threshold sentence
  const rfpSentence = amendmentText.match(/[^\n.]*\brfp\b[^\n.]*/i)?.[0];
  if (rfpSentence) {
    const amt = parseIndianAmount(rfpSentence);
    if (amt) {
      const r55 = draft.rules.find((r) => r.clause_number === '5.5');
      const r56 = draft.rules.find((r) => r.clause_number === '5.6');
      if (r55 && 'all' in r55.conditions && Array.isArray(r55.conditions.all)) {
        for (const c of r55.conditions.all) {
          if ('field' in c && c.field === 'group_value_inr') c.value = amt;
        }
      }
      if (r56 && 'all' in r56.conditions && Array.isArray(r56.conditions.all)) {
        for (const c of r56.conditions.all) {
          if ('field' in c && c.field === 'group_value_inr') c.value = amt;
        }
      }
      draft.plain_language_diff.push(
        `Updated Clause 5.5/5.6 RFQ-to-RFP threshold to ₹${amt.toLocaleString('en-IN')}`
      );
    }
  }

  if (draft.plain_language_diff.length === 0) {
    draft.plain_language_diff.push(
      'Draft created in offline mode — please review or adjust rules in the Policy Rule Editor before activating.'
    );
  }

  return draft;
}

export async function draftPolicyAmendment(opts: {
  amendmentText: string;
  currentPolicy: Policy;
  knownCategories: string[];
  knownPlants: string[];
}): Promise<{
  draft: PolicyAmendmentDraft;
  diff: StructuralDiffSummary;
  used_ai: boolean;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let usedAi = false;
  let draft: PolicyAmendmentDraft | null = null;

  if (groqClient.isConfigured()) {
    const systemPrompt = `You are a precision Procurement Policy Compiler for Corvo Engineering.
Your job is to take the CURRENT active Policy JSON and an incoming POLICY AMENDMENT (document text or natural language instruction), and produce the COMPLETE updated next Policy JSON conforming strictly to the AST schema below.

CRITICAL RULES:
1. Preserve ALL existing unaffected rules and macro parameters from the current policy.
2. Apply EVERY change described in the amendment accurately:
   - Modified value limits (convert lakhs/crores accurately: 1 lakh = 100000, 2.5 lakh = 250000, 10 lakh = 1000000).
   - New plant-specific rules (valid plant codes: ${opts.knownPlants.join(', ')}; Bhosari = PUN1, Chakan = CHK1).
   - Category-specific rules (exact valid categories: ${opts.knownCategories.join(', ')}).
   - Remember RULE ORDER MATTERS! Waterfall executes priority_order 1, 2, 3... first matching rule wins.
     - If a plant or category has a TIGHTER limit (e.g. CHK1 Spot PO capped at ₹1,00,000 while global Spot PO is ₹2,00,000), either place a CHK1 RFQ rule BEFORE Clause 5.4, OR add { "field": "plant", "op": "neq", "value": "CHK1" } to Clause 5.4!
     - If a category/plant has a HIGHER limit or special sourcing route (e.g. Safety & PPE always RFQ, or Services above ₹1,00,000 require RFQ), place that rule BEFORE the generic rule it overrides!
   - Keep priority_order strictly sequential integers starting at 1 (1, 2, 3, ...).
3. Valid condition fields ONLY:
   "item_code" (e.g. "ITM-1048"), "item_type" ("Material"|"Service"|"Capex"), "category", "plant" ("PUN1"|"CHK1"), "department" (e.g. "Maintenance", "Production", "IT", "Stores", "Quality", "Tool Room", "Admin"), "uom" (e.g. "NOS", "KG", "LTR"), "group_value_inr" (number), "urgency" ("Normal"|"Emergency"), "contract_available" (boolean), "has_active_365d_history" (boolean), "is_new_item" (boolean), "total_quantity" (number).
4. Valid condition operators ONLY: "eq", "neq", "lt", "lte", "gt", "gte", "in", "not_in".
5. Condition structure: either leaf { "field", "op", "value" } or compound { "all": [...] } / { "any": [...] } / { "not": {...} }.
6. Valid outcomes: "PO" or "SOURCING_REQUEST".
7. Valid routes: "CONTRACT_PO", "EMERGENCY_PO", "SPOT_PO", "RFQ", "RFP", "CAPEX_SOURCING", "NEW_ITEM_SOURCING" (or uppercase custom route).
8. Valid supplier_strategy: "CONTRACT_HOLDER" (for CONTRACT_PO), "PREFERRED_RANK_1" (for SPOT_PO/EMERGENCY_PO), "SUGGEST_SUPPLIERS" (for RFQ/RFP/CAPEX_SOURCING), "NONE".
9. Extract the exact effective_date in YYYY-MM-DD (if unspecified, use today's date ${new Date().toISOString().slice(0, 10)}).
10. Populate plain_language_diff with concise, crystal-clear bullet points explaining every single change to a non-technical Procurement Head.

Return ONLY valid JSON matching:
{
  "new_version": "5.1",
  "title": "Corvo Engineering Procurement Policy v5.1",
  "effective_date": "YYYY-MM-DD",
  "clubbing_creation_window_days": 14,
  "clubbing_need_by_window_days": 7,
  "po_consolidation_window_hours": 24,
  "active_history_lookback_days": 365,
  "psl_lookback_days": 548,
  "psl_recency_high_days": 90,
  "psl_recency_med_days": 365,
  "rules": [ ... ],
  "plain_language_diff": [ "..." ]
}`;

    const userPrompt = `CURRENT ACTIVE POLICY JSON:
${JSON.stringify(
  {
    version: opts.currentPolicy.version,
    effective_date: opts.currentPolicy.effective_date,
    clubbing_creation_window_days: opts.currentPolicy.clubbing_creation_window_days,
    clubbing_need_by_window_days: opts.currentPolicy.clubbing_need_by_window_days,
    po_consolidation_window_hours: opts.currentPolicy.po_consolidation_window_hours,
    active_history_lookback_days: opts.currentPolicy.active_history_lookback_days,
    psl_lookback_days: opts.currentPolicy.psl_lookback_days,
    psl_recency_high_days: opts.currentPolicy.psl_recency_high_days,
    psl_recency_med_days: opts.currentPolicy.psl_recency_med_days,
    rules: opts.currentPolicy.rules
  },
  null,
  2
)}

INCOMING POLICY AMENDMENT:
${opts.amendmentText}`;

    const aiRes = await groqClient.completeJson(
      systemPrompt,
      userPrompt,
      PolicyAmendmentDraftSchema
    );

    if (aiRes.ok && aiRes.data) {
      const aiDraft = aiRes.data;
      // Guarantee contiguous 1..N priority ordering
      aiDraft.rules = [...aiDraft.rules]
        .sort((a, b) => a.priority_order - b.priority_order)
        .map((r, idx) => ({ ...r, priority_order: idx + 1 }));
      draft = aiDraft;
      usedAi = true;
    } else {
      warnings.push(aiRes.fallbackReason || 'Groq parsing failed; used deterministic fallback.');
    }
  } else {
    warnings.push('GROQ_API_KEY not configured; used deterministic fallback parser.');
  }

  if (!draft) {
    draft = parseAmendmentDeterministic(
      opts.amendmentText,
      opts.currentPolicy,
      opts.knownCategories
    );
  }

  const diff = computePolicyDiff(opts.currentPolicy, draft);

  return { draft, diff, used_ai: usedAi, warnings };
}
