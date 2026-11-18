export type ItemType = 'Material' | 'Service' | 'Capex';
export type SupplierStatus = 'Active' | 'Blocked' | 'Inactive';
export type Urgency = 'Normal' | 'Emergency';
export type DecisionType = 'PO' | 'SOURCING_REQUEST' | 'NOT_PROCESSED';

export type RouteType =
  | 'CONTRACT_PO'
  | 'EMERGENCY_PO'
  | 'SPOT_PO'
  | 'RFQ'
  | 'RFP'
  | 'CAPEX_SOURCING'
  | 'NEW_ITEM_SOURCING'
  | 'NOT_PROCESSED'
  | string;

export type SupplierStrategy =
  | 'CONTRACT_HOLDER'
  | 'PREFERRED_RANK_1'
  | 'SUGGEST_SUPPLIERS'
  | 'NONE';

export interface Plant {
  code: string;
  name: string;
}

export interface Item {
  item_code: string;
  description: string;
  uom: string;
  category: string;
  item_type: ItemType;
  standard_price: number;
}

export interface Supplier {
  supplier_id: string;
  name: string;
  city: string;
  status: SupplierStatus;
  on_time_pct: number;
  quality_rating: number;
  categories: string[];
}

export interface POHistoryEntry {
  po_number: string;
  po_date: string; // YYYY-MM-DD
  supplier_id: string;
  item_code: string;
  quantity: number;
  uom: string;
  unit_price: number;
  plant: string;
  delivered_on_time: boolean;
}

export interface Contract {
  contract_id: string;
  supplier_id: string;
  supplier_name: string;
  start_date: string; // YYYY-MM-DD
  end_date: string;   // YYYY-MM-DD
  value_cap: number;
  initial_consumed_value: number;
  current_consumed_value: number;
  source: 'REGISTER_CSV' | 'SIGNED_PDF' | 'MANUAL';
}

export interface ContractLine {
  contract_id: string;
  item_code: string;
  description: string;
  uom: string;
  rate: number;
}

export type ConditionField =
  | 'item_code'
  | 'item_type'
  | 'category'
  | 'plant'
  | 'department'
  | 'uom'
  | 'group_value_inr'
  | 'urgency'
  | 'contract_available'
  | 'has_active_365d_history'
  | 'is_new_item'
  | 'total_quantity';

export type ConditionOperator =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'not_in';

export interface LeafCondition {
  field: ConditionField;
  op: ConditionOperator;
  value: string | number | boolean | string[];
}

export interface CompoundCondition {
  all?: PolicyCondition[];
  any?: PolicyCondition[];
  not?: PolicyCondition;
}

export type PolicyCondition = LeafCondition | CompoundCondition;

export interface PolicyRule {
  rule_id?: number;
  policy_id?: number;
  clause_number: string;
  priority_order: number;
  rule_name: string;
  conditions: PolicyCondition;
  outcome: 'PO' | 'SOURCING_REQUEST';
  route: RouteType;
  supplier_strategy: SupplierStrategy;
  supplier_suggestion_count: number;
  notes?: string;
}

export interface Policy {
  policy_id: number;
  document_code: string;
  version: string;
  title: string;
  effective_date: string; // YYYY-MM-DD
  status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
  created_at: string;
  approved_by: string | null;
  approved_at?: string | null;
  summary_diff?: string | null;
  clubbing_creation_window_days: number;
  clubbing_need_by_window_days: number;
  po_consolidation_window_hours: number;
  active_history_lookback_days: number;
  psl_lookback_days: number;
  psl_recency_high_days: number;
  psl_recency_med_days: number;
  rules: PolicyRule[];
}

export interface PRLine {
  pr_no: string;
  pr_line: number;
  created_at: string; // YYYY-MM-DD HH:mm
  requester: string;
  department: string;
  plant: string;
  raw_item_code: string | null;
  description: string;
  quantity: number;
  uom: string;
  estimated_unit_price: number | null;
  need_by_date: string; // YYYY-MM-DD
  urgency: Urgency;
  resolved_item_code?: string;
  is_new_item?: boolean;
  match_confidence?: number;
  had_text_urgent_tag?: boolean;
}

export interface Requirement {
  group_id: string;
  resolved_item_code: string;
  plant: string;
  first_created_at: string;
  first_need_by_date: string;
  lines: PRLine[];
  total_quantity: number;
  is_emergency: boolean;
}

export interface ValuationResult {
  unit_price: number;
  exact_value_inr: number;
  group_value_inr: number;
  contract_used: Contract | null;
  pricing_basis: string;
  reference_doc: string;
}

export interface SupplierScoreBreakdown {
  contract_score: number;
  volume_score: number;
  recency_score: number;
  quality_score: number;
  on_time_score: number;
  po_count_548d: number;
  recency_bracket: number;
  held_contract: boolean;
  quality_rating: number;
  on_time_pct: number;
}

export interface SupplierRankScore {
  supplier_id: string;
  supplier_name: string;
  rank: number;
  composite_score: number;
  reference_price: number;
  reference_source: string;
  breakdown: SupplierScoreBreakdown;
}

export interface EvaluatedRequirement {
  requirement: Requirement;
  policy_version: string;
  clause_applied: string;
  supplier_strategy: SupplierStrategy;
  decision: DecisionType;
  route: RouteType;
  supplier_id: string;
  unit_price: string; // exact 2-decimal string for PO, '' for sourcing
  group_value_inr: number;
  suggested_supplier_ids: string;
  reason: string;
  reference_doc: string;
}

export interface DecisionOutput {
  pr_no: string;
  pr_line: number;
  resolved_item_code: string;
  group_id: string;
  po_id: string;
  decision: DecisionType;
  route: RouteType;
  supplier_id: string;
  unit_price: string;
  group_value_inr: number;
  suggested_supplier_ids: string;
  policy_version: string;
  reason: string;
}
