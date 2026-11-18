import { z } from 'zod';
import {
  ConditionField,
  ConditionOperator,
  LeafCondition,
  PolicyCondition,
  PolicyRule
} from './types.js';

export const ConditionFieldSchema = z.enum([
  'item_type',
  'category',
  'plant',
  'group_value_inr',
  'urgency',
  'contract_available',
  'has_active_365d_history',
  'is_new_item',
  'total_quantity'
]);

export const ConditionOperatorSchema = z.enum([
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'not_in'
]);

export const LeafConditionSchema = z.object({
  field: ConditionFieldSchema,
  op: ConditionOperatorSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
});

export const PolicyConditionSchema: z.ZodType<PolicyCondition> = z.lazy(() =>
  z.union([
    LeafConditionSchema.strict(),
    z
      .object({
        all: z.array(PolicyConditionSchema).min(1).optional(),
        any: z.array(PolicyConditionSchema).min(1).optional(),
        not: PolicyConditionSchema.optional()
      })
      .strict()
      .refine((c) => Boolean(c.all || c.any || c.not), {
        message: 'Compound condition must specify at least one of all, any, or not'
      })
  ])
);

export const PolicyRuleSchema = z.object({
  clause_number: z.string().min(1),
  priority_order: z.number().int().min(1),
  rule_name: z.string().min(1),
  conditions: PolicyConditionSchema,
  outcome: z.enum(['PO', 'SOURCING_REQUEST']),
  route: z.string().min(1),
  supplier_strategy: z.enum([
    'CONTRACT_HOLDER',
    'PREFERRED_RANK_1',
    'SUGGEST_SUPPLIERS',
    'NONE'
  ]),
  supplier_suggestion_count: z.number().int().min(0).default(0),
  notes: z.string().optional()
});

export interface EvaluationContext {
  item_type: string;
  category: string;
  plant: string;
  group_value_inr: number;
  urgency: string;
  contract_available: boolean;
  has_active_365d_history: boolean;
  is_new_item: boolean;
  total_quantity: number;
}

function isLeafCondition(cond: PolicyCondition): cond is LeafCondition {
  return 'field' in cond && 'op' in cond;
}

function evaluateLeaf(cond: LeafCondition, ctx: EvaluationContext): boolean {
  const actual = ctx[cond.field as ConditionField];
  const expected = cond.value;

  const op: ConditionOperator = cond.op;
  switch (op) {
    case 'eq':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.toLowerCase() === expected.toLowerCase();
      }
      return actual === expected;
    case 'neq':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.toLowerCase() !== expected.toLowerCase();
      }
      return actual !== expected;
    case 'lt':
      return Number(actual) < Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'gt':
      return Number(actual) > Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'in': {
      if (!Array.isArray(expected)) return false;
      const lowerActual = String(actual).toLowerCase();
      return expected.some((v) => String(v).toLowerCase() === lowerActual);
    }
    case 'not_in': {
      if (!Array.isArray(expected)) return true;
      const lowerActual = String(actual).toLowerCase();
      return !expected.some((v) => String(v).toLowerCase() === lowerActual);
    }
    default:
      return false;
  }
}

export function evaluateCondition(
  condition: PolicyCondition,
  ctx: EvaluationContext
): boolean {
  if (isLeafCondition(condition)) {
    return evaluateLeaf(condition, ctx);
  }
  if (condition.all && condition.all.length > 0) {
    if (!condition.all.every((c) => evaluateCondition(c, ctx))) {
      return false;
    }
  }
  if (condition.any && condition.any.length > 0) {
    if (!condition.any.some((c) => evaluateCondition(c, ctx))) {
      return false;
    }
  }
  if (condition.not) {
    if (evaluateCondition(condition.not, ctx)) {
      return false;
    }
  }
  return true;
}

export function getBaselinePolicyV5Rules(): PolicyRule[] {
  return [
    {
      clause_number: '5.1',
      priority_order: 1,
      rule_name: 'Capex Sourcing',
      conditions: {
        all: [{ field: 'item_type', op: 'eq', value: 'Capex' }]
      },
      outcome: 'SOURCING_REQUEST',
      route: 'CAPEX_SOURCING',
      supplier_strategy: 'SUGGEST_SUPPLIERS',
      supplier_suggestion_count: 5,
      notes: 'Needs capex approval. Checked before contracts and value limits.'
    },
    {
      clause_number: '5.2',
      priority_order: 2,
      rule_name: 'Rate Contract PO',
      conditions: {
        all: [{ field: 'contract_available', op: 'eq', value: true }]
      },
      outcome: 'PO',
      route: 'CONTRACT_PO',
      supplier_strategy: 'CONTRACT_HOLDER',
      supplier_suggestion_count: 0,
      notes: 'Active rate contract covering item with sufficient ceiling room.'
    },
    {
      clause_number: '5.3',
      priority_order: 3,
      rule_name: 'Emergency PO',
      conditions: {
        all: [
          { field: 'urgency', op: 'eq', value: 'Emergency' },
          { field: 'group_value_inr', op: 'lte', value: 500000 },
          { field: 'has_active_365d_history', op: 'eq', value: true }
        ]
      },
      outcome: 'PO',
      route: 'EMERGENCY_PO',
      supplier_strategy: 'PREFERRED_RANK_1',
      supplier_suggestion_count: 0,
      notes: 'Emergency up to INR 5,00,000 with Active supplier PO history in last 365 days.'
    },
    {
      clause_number: '5.4',
      priority_order: 4,
      rule_name: 'Spot PO',
      conditions: {
        all: [
          { field: 'group_value_inr', op: 'lt', value: 200000 },
          { field: 'has_active_365d_history', op: 'eq', value: true }
        ]
      },
      outcome: 'PO',
      route: 'SPOT_PO',
      supplier_strategy: 'PREFERRED_RANK_1',
      supplier_suggestion_count: 0,
      notes: 'Value below INR 2,00,000 with Active supplier PO history in last 365 days.'
    },
    {
      clause_number: '5.5',
      priority_order: 5,
      rule_name: 'RFQ Sourcing',
      conditions: {
        all: [{ field: 'group_value_inr', op: 'lt', value: 1000000 }]
      },
      outcome: 'SOURCING_REQUEST',
      route: 'RFQ',
      supplier_strategy: 'SUGGEST_SUPPLIERS',
      supplier_suggestion_count: 3,
      notes: 'Value below INR 10,00,000 (including small items lacking 365-day Active history).'
    },
    {
      clause_number: '5.6',
      priority_order: 6,
      rule_name: 'RFP Sourcing',
      conditions: {
        all: [{ field: 'group_value_inr', op: 'gte', value: 1000000 }]
      },
      outcome: 'SOURCING_REQUEST',
      route: 'RFP',
      supplier_strategy: 'SUGGEST_SUPPLIERS',
      supplier_suggestion_count: 5,
      notes: 'Value INR 10,00,000 or more requires formal RFP.'
    }
  ];
}
