export interface HealthResponse {
  status: string;
  active_policy_version: string;
  active_policy_effective_date: string | null;
  groq_configured: boolean;
  counts: {
    plants: number;
    items: number;
    suppliers: number;
    contracts: number;
    po_history: number;
  };
}

export interface MasterDataResponse {
  plants: Array<{ code: string; name: string }>;
  items: Array<{
    item_code: string;
    description: string;
    uom: string;
    category: string;
    item_type: string;
    standard_price: number;
  }>;
  suppliers: Array<{
    supplier_id: string;
    name: string;
    city: string;
    status: 'Active' | 'Blocked' | 'Inactive';
    on_time_pct: number;
    quality_rating: number;
    categories: string[];
  }>;
  categories: string[];
}

export interface ChatSlots {
  item_query: string | null;
  resolved_item_code: string | null;
  item_description: string | null;
  uom: string | null;
  item_match_status: 'UNSET' | 'MATCHED' | 'AMBIGUOUS' | 'NEW_ITEM';
  candidate_items: Array<{ item_code: string; description: string; uom: string; score: number }>;
  quantity: number | null;
  plant: string | null;
  need_by_date: string | null;
  urgency: 'Normal' | 'Emergency' | null;
  estimated_unit_price: number | null;
  requester: string;
  department: string;
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
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
}

export interface BatchProcessResponse {
  batch_id: number;
  filename: string;
  uploaded_at: string;
  policy_version: string;
  summary: {
    total_lines: number;
    requirements_count: number;
    consolidated_po_count: number;
    anomalies_count: number;
    decision_counts: Record<string, number>;
    route_counts: Record<string, number>;
  };
  decisions: Array<{
    pr_no: string;
    pr_line: number;
    resolved_item_code: string;
    group_id: string;
    po_id: string;
    decision: string;
    route: string;
    supplier_id: string;
    unit_price: string;
    group_value_inr: number;
    suggested_supplier_ids: string;
    policy_version: string;
    reason: string;
  }>;
}

export interface RequirementRecord {
  id: number;
  batch_id: number | null;
  group_id: string;
  po_id: string;
  resolved_item_code: string;
  item_description: string;
  item_category: string;
  item_type: string;
  uom: string;
  plant: string;
  first_created_at: string;
  first_need_by_date: string;
  total_quantity: number;
  is_emergency: boolean;
  decision: string;
  route: string;
  supplier_id: string;
  supplier_name: string;
  unit_price: string;
  group_value_inr: number;
  suggested_supplier_ids: string;
  suggested_suppliers: Array<{
    supplier_id: string;
    name: string;
    on_time_pct: number;
    quality_rating: number;
    rank: number | null;
    composite_score: number | null;
    source: string;
  }>;
  policy_version: string;
  clause_applied: string;
  reason: string;
  reference_doc: string;
  lines: Array<{
    pr_no: string;
    pr_line: number;
    created_at: string;
    requester: string;
    department: string;
    quantity: number;
    need_by_date: string;
    urgency: string;
    description: string;
  }>;
  status: string;
  actioned_by: string | null;
  actioned_at: string | null;
  override_decision: string | null;
  override_route: string | null;
  override_supplier_id: string | null;
  override_comment: string | null;
  created_order_ref: string | null;
  preferred_supplier_breakdown: Array<{
    supplier_id: string;
    supplier_name: string;
    rank: number;
    composite_score: number;
    reference_price: number;
    reference_source: string;
    breakdown: {
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
    };
  }>;
}

export interface PolicyRuleDto {
  clause_number: string;
  priority_order: number;
  rule_name: string;
  conditions: unknown;
  outcome: 'PO' | 'SOURCING_REQUEST';
  route: string;
  supplier_strategy: string;
  supplier_suggestion_count: number;
  notes?: string;
}

export interface PolicyDto {
  policy_id: number;
  document_code: string;
  version: string;
  title: string;
  effective_date: string;
  status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  summary_diff: string | null;
  clubbing_creation_window_days: number;
  clubbing_need_by_window_days: number;
  po_consolidation_window_hours: number;
  active_history_lookback_days: number;
  psl_lookback_days: number;
  rules: PolicyRuleDto[];
}

export interface ContractDto {
  contract_id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_status: string;
  start_date: string;
  end_date: string;
  value_cap: number;
  initial_consumed_value: number;
  remaining_value: number;
  utilization_pct: number;
  validity_status: 'ACTIVE' | 'EXPIRED' | 'UPCOMING' | 'BLOCKED_SUPPLIER';
  source: string;
  lines: Array<{
    item_code: string;
    description: string;
    uom: string;
    rate: number;
  }>;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  getHealth: () => apiFetch<HealthResponse>('/api/health'),
  getMasterData: () => apiFetch<MasterDataResponse>('/api/master-data'),

  // Chat Intake
  sendChatMessage: (payload: {
    session_id?: string;
    message: string;
    reference_date?: string;
  }) =>
    apiFetch<ChatTurnResponse>('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }),

  confirmChatPr: (payload: {
    session_id: string;
    requester?: string;
    department?: string;
  }) =>
    apiFetch<{
      pr_no: string;
      requirement_id: number;
      group_id: string;
      clubbed_with_existing?: boolean;
      decision: BatchProcessResponse['decisions'][number];
    }>('/api/chat/confirm-pr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }),

  // Batches
  processBatchFile: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return apiFetch<BatchProcessResponse>('/api/process-batch', {
      method: 'POST',
      body: fd
    });
  },
  processSampleBatch: () =>
    apiFetch<BatchProcessResponse>('/api/process-sample-batch', { method: 'POST' }),
  getBatches: () =>
    apiFetch<{
      batches: Array<{
        batch_id: number;
        filename: string;
        uploaded_at: string;
        policy_version_at_run: string;
        total_lines: number;
      }>;
    }>('/api/batches'),

  // Buyer Workspace
  getRequirements: (params?: { batch_id?: number; status?: string; decision?: string }) => {
    const qs = new URLSearchParams();
    if (params?.batch_id) qs.set('batch_id', String(params.batch_id));
    if (params?.status) qs.set('status', params.status);
    if (params?.decision) qs.set('decision', params.decision);
    return apiFetch<{ batch_id: number | null; count: number; requirements: RequirementRecord[] }>(
      `/api/requirements?${qs.toString()}`
    );
  },
  approveRequirement: (id: number, actor: string) =>
    apiFetch<{ id: number; status: string; created_order_ref: string }>(
      `/api/requirements/${id}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor })
      }
    ),
  overrideRequirement: (
    id: number,
    payload: {
      actor: string;
      comment: string;
      override_decision: 'PO' | 'SOURCING_REQUEST' | 'NOT_PROCESSED';
      override_route: string;
      override_supplier_id?: string | null;
    }
  ) =>
    apiFetch<{ id: number; status: string; created_order_ref: string | null }>(
      `/api/requirements/${id}/override`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    ),
  getOrders: () =>
    apiFetch<{
      purchase_orders: Array<Record<string, unknown>>;
      sourcing_requests: Array<Record<string, unknown>>;
    }>('/api/orders'),
  getAuditLogs: () =>
    apiFetch<{
      logs: Array<{
        log_id: number;
        entity_type: string;
        entity_id: string;
        action: string;
        actor: string;
        timestamp: string;
        details: Record<string, unknown>;
      }>;
    }>('/api/audit-logs'),

  // Policy Studio
  getPolicies: () =>
    apiFetch<{ active_policy: PolicyDto | null; policies: PolicyDto[] }>('/api/policies'),
  amendPolicyByChat: (instruction: string, actor = 'Head of Procurement') =>
    apiFetch<{
      policy_id: number;
      draft_policy: PolicyDto;
      diff: {
        parameter_changes: string[];
        rules_added: string[];
        rules_modified: string[];
        rules_removed: string[];
        plain_language_summary: string[];
      };
      used_ai: boolean;
      warnings: string[];
    }>('/api/policy/amend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, actor })
    }),
  amendPolicyByFile: (file: File, actor = 'Head of Procurement') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('actor', actor);
    return apiFetch<{
      policy_id: number;
      draft_policy: PolicyDto;
      diff: {
        parameter_changes: string[];
        rules_added: string[];
        rules_modified: string[];
        rules_removed: string[];
        plain_language_summary: string[];
      };
      used_ai: boolean;
      warnings: string[];
    }>('/api/policy/amend', {
      method: 'POST',
      body: fd
    });
  },
  updateDraftPolicy: (id: number, payload: Partial<PolicyDto>) =>
    apiFetch<{ draft_policy: PolicyDto; diff: unknown }>(`/api/policy/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }),
  activatePolicy: (id: number, approved_by: string) =>
    apiFetch<{ message: string; active_policy: PolicyDto }>(`/api/policy/${id}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved_by })
    }),
  deleteDraftPolicy: (id: number) =>
    apiFetch<{ deleted: boolean }>(`/api/policy/${id}`, { method: 'DELETE' }),

  // Contracts
  getContracts: (asOfDate?: string) =>
    apiFetch<{ as_of_date: string; contracts: ContractDto[] }>(
      `/api/contracts${asOfDate ? `?as_of_date=${asOfDate}` : ''}`
    ),
  uploadContractPdf: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return apiFetch<{
      filename: string;
      extracted: {
        contract_id: string;
        supplier_id: string;
        supplier_name: string;
        start_date: string;
        end_date: string;
        value_cap: number;
        initial_consumed_value: number;
        source: string;
        lines: Array<{ item_code: string; description: string; uom: string; rate: number }>;
        extraction_method: string;
      };
    }>('/api/contracts/upload-pdf', { method: 'POST', body: fd });
  },
  saveContract: (payload: {
    contract_id: string;
    supplier_id: string;
    supplier_name?: string;
    start_date: string;
    end_date: string;
    value_cap: number;
    initial_consumed_value?: number;
    source?: 'SIGNED_PDF' | 'MANUAL';
    actor?: string;
    lines: Array<{ item_code: string; description: string; uom: string; rate: number }>;
  }) =>
    apiFetch<{ message: string; contract_id: string }>('/api/contracts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }),

  // Preferred Suppliers
  getPreferredSuppliers: (asOfDate: string) =>
    apiFetch<{
      as_of_date: string;
      scoring_weights: Record<string, number>;
      items: Array<{
        item_code: string;
        description: string;
        category: string;
        item_type: string;
        uom: string;
        standard_price: number;
        preferred_suppliers: RequirementRecord['preferred_supplier_breakdown'];
      }>;
    }>(`/api/preferred-suppliers?as_of_date=${asOfDate}&format=json`)
};

export function formatInr(val: number | string): string {
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val);
  return '₹' + Math.round(num).toLocaleString('en-IN');
}
