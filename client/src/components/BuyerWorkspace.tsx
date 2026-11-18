import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Edit3,
  Download,
  History,
  FileCheck2,
  AlertTriangle
} from 'lucide-react';
import { api, formatInr, MasterDataResponse, RequirementRecord } from '../api/client';

interface Props {
  initialBatchId?: number;
  masterData: MasterDataResponse | null;
  refreshTick: number;
}

function routeBadgeClass(route: string): string {
  if (route === 'CONTRACT_PO' || route === 'SPOT_PO') return 'badge badge-po';
  if (route === 'EMERGENCY_PO') return 'badge badge-emergency';
  if (route === 'CAPEX_SOURCING') return 'badge badge-capex';
  if (route === 'NOT_PROCESSED') return 'badge badge-error';
  return 'badge badge-sourcing';
}

export const BuyerWorkspace: React.FC<Props> = ({ initialBatchId, masterData, refreshTick }) => {
  const [subTab, setSubTab] = useState<'queue' | 'orders' | 'audit'>('queue');
  const [requirements, setRequirements] = useState<RequirementRecord[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<number | null>(initialBatchId ?? null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [routeFilter, setRouteFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [buyerName, setBuyerName] = useState('Priya Sharma (Buyer)');
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Override modal state
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideDecision, setOverrideDecision] = useState<'PO' | 'SOURCING_REQUEST' | 'NOT_PROCESSED'>('PO');
  const [overrideRoute, setOverrideRoute] = useState('SPOT_PO');
  const [overrideSupplier, setOverrideSupplier] = useState('');
  const [overrideComment, setOverrideComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Orders & Audit state
  const [orders, setOrders] = useState<{
    purchase_orders: Array<Record<string, unknown>>;
    sourcing_requests: Array<Record<string, unknown>>;
  }>({ purchase_orders: [], sourcing_requests: [] });
  const [auditLogs, setAuditLogs] = useState<
    Array<{
      log_id: number;
      entity_type: string;
      entity_id: string;
      action: string;
      actor: string;
      timestamp: string;
      details: Record<string, unknown>;
    }>
  >([]);

  const loadWorkspace = async () => {
    setLoading(true);
    try {
      const [reqRes, ordRes, audRes] = await Promise.all([
        api.getRequirements(initialBatchId ? { batch_id: initialBatchId } : undefined),
        api.getOrders(),
        api.getAuditLogs()
      ]);
      setRequirements(reqRes.requirements);
      setActiveBatchId(reqRes.batch_id);
      setOrders(ordRes);
      setAuditLogs(audRes.logs);
      if (reqRes.requirements.length > 0 && !reqRes.requirements.some((r) => r.id === selectedId)) {
        setSelectedId(reqRes.requirements[0].id);
      }
    } catch (e) {
      setFeedback({ type: 'error', text: e instanceof Error ? e.message : 'Failed to load workspace' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkspace();
  }, [initialBatchId, refreshTick]);

  const filtered = useMemo(() => {
    return requirements.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (routeFilter && r.route !== routeFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const hay = `${r.group_id} ${r.resolved_item_code} ${r.item_description} ${r.supplier_id} ${r.supplier_name} ${r.plant} ${r.lines.map((l) => l.pr_no).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [requirements, statusFilter, routeFilter, search]);

  const selected = useMemo(
    () => filtered.find((r) => r.id === selectedId) || filtered[0] || null,
    [filtered, selectedId]
  );

  const activeSuppliers = useMemo(
    () => (masterData?.suppliers || []).filter((s) => s.status === 'Active'),
    [masterData]
  );

  const handleApprove = async (req: RequirementRecord) => {
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await api.approveRequirement(req.id, buyerName);
      setFeedback({
        type: 'success',
        text: `Approved ${req.group_id} — created ${res.created_order_ref}.`
      });
      await loadWorkspace();
    } catch (e) {
      setFeedback({ type: 'error', text: e instanceof Error ? e.message : 'Approve failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const openOverrideModal = (req: RequirementRecord) => {
    setOverrideDecision(req.decision === 'PO' ? 'SOURCING_REQUEST' : 'PO');
    setOverrideRoute(req.decision === 'PO' ? 'RFQ' : 'SPOT_PO');
    setOverrideSupplier(req.supplier_id || req.preferred_supplier_breakdown[0]?.supplier_id || '');
    setOverrideComment('');
    setOverrideOpen(true);
  };

  const handleOverrideSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await api.overrideRequirement(selected.id, {
        actor: buyerName,
        comment: overrideComment,
        override_decision: overrideDecision,
        override_route: overrideRoute,
        override_supplier_id: overrideDecision === 'PO' ? overrideSupplier || null : null
      });
      setOverrideOpen(false);
      setFeedback({
        type: 'success',
        text: `Overridden ${selected.group_id} (${res.created_order_ref || 'recorded'}) with audit comment.`
      });
      await loadWorkspace();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Override failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const stats = useMemo(() => {
    const pending = requirements.filter((r) => r.status === 'PENDING_REVIEW').length;
    const pos = requirements.filter((r) => r.decision === 'PO').length;
    const sourcing = requirements.filter((r) => r.decision === 'SOURCING_REQUEST').length;
    const exceptions = requirements.filter((r) => r.decision === 'NOT_PROCESSED').length;
    const actioned = requirements.filter(
      (r) => r.status === 'APPROVED' || r.status === 'OVERRIDDEN'
    ).length;
    return { pending, pos, sourcing, exceptions, actioned };
  }, [requirements]);

  return (
    <div>
      {/* KPI Strip */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Pending Buyer Review</div>
          <div className="kpi-value">{stats.pending}</div>
          <div className="kpi-sub">Requirements awaiting action</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Direct POs</div>
          <div className="kpi-value" style={{ color: 'var(--emerald)' }}>{stats.pos}</div>
          <div className="kpi-sub">Contract, Spot & Emergency</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Sourcing Requests</div>
          <div className="kpi-value" style={{ color: 'var(--primary)' }}>{stats.sourcing}</div>
          <div className="kpi-sub">RFQ, RFP, Capex & New Item</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Flagged Exceptions</div>
          <div className="kpi-value" style={{ color: 'var(--rose)' }}>{stats.exceptions}</div>
          <div className="kpi-sub">NOT_PROCESSED (overrideable)</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Actioned</div>
          <div className="kpi-value">{stats.actioned}</div>
          <div className="kpi-sub">Approved or overridden</div>
        </div>
      </div>

      {/* Sub-navigation + Export Action */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          <button className={`tab-btn ${subTab === 'queue' ? 'active' : ''}`} onClick={() => setSubTab('queue')}>
            Decision Queue ({requirements.length})
          </button>
          <button className={`tab-btn ${subTab === 'orders' ? 'active' : ''}`} onClick={() => setSubTab('orders')}>
            <FileCheck2 size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
            Issued POs & RFQs ({orders.purchase_orders.length + orders.sourcing_requests.length})
          </button>
          <button className={`tab-btn ${subTab === 'audit' ? 'active' : ''}`} onClick={() => setSubTab('audit')}>
            <History size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
            Audit Trail ({auditLogs.length})
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="input"
            style={{ width: 190 }}
            value={buyerName}
            onChange={(e) => setBuyerName(e.target.value)}
            title="Actor name recorded in audit trail"
          />
          {activeBatchId && (
            <a
              href={`/api/export-decisions?batch_id=${activeBatchId}`}
              className="btn btn-secondary btn-sm"
              style={{ textDecoration: 'none' }}
            >
              <Download size={14} /> Export Batch CSV
            </a>
          )}
        </div>
      </div>

      {feedback && (
        <div className={`alert ${feedback.type === 'success' ? 'alert-success' : 'alert-error'}`}>
          {feedback.text}
        </div>
      )}

      {subTab === 'queue' && (
        <>
          {requirements.length === 0 ? (
            <div className="card">
              <div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
                <p style={{ color: 'var(--text-muted)', marginBottom: 8 }}>
                  No requirements in the Buyer Workspace yet.
                </p>
                <p style={{ fontSize: 13, color: 'var(--text-subtle)', marginBottom: 16 }}>
                  Raise a PR in <strong>Chat Intake</strong>, upload a PR batch CSV, or load the 186-line kit sample batch in one click:
                </p>
                <button
                  className="btn btn-primary"
                  disabled={submitting}
                  onClick={async () => {
                    setSubmitting(true);
                    setFeedback(null);
                    try {
                      const res = await api.processSampleBatch();
                      setFeedback({
                        type: 'success',
                        text: `Loaded sample_pr_batch.csv (${res.summary.total_lines} PR lines -> ${res.summary.requirements_count} requirements) under ${res.policy_version}.`
                      });
                      await loadWorkspace();
                    } catch (e) {
                      setFeedback({ type: 'error', text: e instanceof Error ? e.message : 'Failed' });
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                >
                  {submitting ? 'Processing 186 PR Lines...' : 'Load Sample Batch (186 PRs)'}
                </button>
              </div>
            </div>
          ) : (
            <div className="workspace-grid">
              {/* Left Table */}
              <div className="card">
                <div className="card-header" style={{ flexWrap: 'wrap' }}>
                  <input
                    className="input"
                    style={{ maxWidth: 230 }}
                    placeholder="Search PR, item, supplier..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select
                      className="select"
                      style={{ width: 145 }}
                      value={routeFilter}
                      onChange={(e) => setRouteFilter(e.target.value)}
                    >
                      <option value="">All Routes</option>
                      <option value="CONTRACT_PO">CONTRACT_PO</option>
                      <option value="SPOT_PO">SPOT_PO</option>
                      <option value="EMERGENCY_PO">EMERGENCY_PO</option>
                      <option value="RFQ">RFQ</option>
                      <option value="RFP">RFP</option>
                      <option value="CAPEX_SOURCING">CAPEX_SOURCING</option>
                      <option value="NEW_ITEM_SOURCING">NEW_ITEM_SOURCING</option>
                      <option value="NOT_PROCESSED">NOT_PROCESSED</option>
                    </select>
                    <select
                      className="select"
                      style={{ width: 145 }}
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                    >
                      <option value="">All Statuses</option>
                      <option value="PENDING_REVIEW">Pending Review</option>
                      <option value="APPROVED">Approved</option>
                      <option value="OVERRIDDEN">Overridden</option>
                      <option value="FLAGGED_EXCEPTION">Exception</option>
                    </select>
                  </div>
                </div>
                <div className="table-wrap" style={{ maxHeight: 620, overflowY: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Requirement</th>
                        <th>Item</th>
                        <th>Route</th>
                        <th>Value</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((r) => (
                        <tr
                          key={r.id}
                          className={`clickable ${selected?.id === r.id ? 'selected-row' : ''}`}
                          onClick={() => setSelectedId(r.id)}
                        >
                          <td>
                            <div className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>
                              {r.group_id}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-subtle)' }}>
                              {r.plant} · {r.lines.length} PR{r.lines.length > 1 ? 's clubbed' : ''}
                            </div>
                          </td>
                          <td>
                            <div style={{ fontWeight: 600 }}>{r.item_description}</div>
                            <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-subtle)' }}>
                              {r.resolved_item_code} · Qty {r.total_quantity} {r.uom}
                            </div>
                          </td>
                          <td>
                            <span className={routeBadgeClass(r.route)}>{r.route}</span>
                            {r.po_id && (
                              <div className="mono" style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 3 }}>
                                {r.po_id}
                              </div>
                            )}
                          </td>
                          <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                            {formatInr(r.group_value_inr)}
                          </td>
                          <td>
                            <span
                              className={`badge ${
                                r.status === 'APPROVED'
                                  ? 'badge-po'
                                  : r.status === 'OVERRIDDEN'
                                    ? 'badge-emergency'
                                    : r.status === 'FLAGGED_EXCEPTION'
                                      ? 'badge-error'
                                      : 'badge-neutral'
                              }`}
                            >
                              {r.status.replace('_', ' ')}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Right Detail & Action Panel */}
              {selected && (
                <div className="card" style={{ position: 'sticky', top: 88 }}>
                  <div className="card-header">
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <h2 className="mono">{selected.group_id}</h2>
                        <span className={routeBadgeClass(selected.route)}>{selected.route}</span>
                        {selected.is_emergency && <span className="badge badge-emergency">Emergency</span>}
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--text-subtle)', marginTop: 3 }}>
                        {selected.resolved_item_code} · {selected.item_description} ({selected.item_category})
                      </div>
                    </div>
                  </div>
                  <div className="card-body">
                    {/* Primary Action Bar */}
                    <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                      {selected.decision !== 'NOT_PROCESSED' && (
                        <button
                          className="btn btn-emerald"
                          style={{ flex: 1 }}
                          disabled={submitting || selected.status === 'APPROVED'}
                          onClick={() => handleApprove(selected)}
                        >
                          <CheckCircle2 size={15} />
                          {selected.status === 'APPROVED'
                            ? `Approved (${selected.created_order_ref})`
                            : selected.decision === 'PO'
                              ? 'Approve & Issue PO'
                              : `Approve & Create ${selected.route}`}
                        </button>
                      )}
                      <button
                        className="btn btn-secondary"
                        style={{ flex: selected.decision === 'NOT_PROCESSED' ? 1 : undefined }}
                        disabled={submitting}
                        onClick={() => openOverrideModal(selected)}
                      >
                        <Edit3 size={15} /> Override
                      </button>
                    </div>

                    {selected.status === 'OVERRIDDEN' && (
                      <div className="alert alert-warn">
                        <strong>Overridden by {selected.actioned_by}</strong> →{' '}
                        <code>{selected.override_route}</code>
                        {selected.override_supplier_id ? ` (${selected.override_supplier_id})` : ''}
                        <div style={{ marginTop: 4 }}>Reason: “{selected.override_comment}”</div>
                      </div>
                    )}

                    {/* Core Decision Explanation */}
                    <div
                      style={{
                        background: '#f8fafc',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: 13,
                        marginBottom: 14
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-subtle)' }}>
                          WHY THIS DECISION ({selected.policy_version} · CLAUSE {selected.clause_applied})
                        </span>
                        <strong style={{ fontSize: 15 }}>{formatInr(selected.group_value_inr)}</strong>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text)' }}>{selected.reason}</div>
                      {selected.supplier_id && (
                        <div style={{ marginTop: 8, fontSize: 13 }}>
                          <strong>Awarded Supplier:</strong> {selected.supplier_id} — {selected.supplier_name} @{' '}
                          <span className="mono">₹{selected.unit_price}</span> / {selected.uom}
                          {selected.po_id && (
                            <span className="badge badge-neutral" style={{ marginLeft: 8 }}>
                              Consolidated PO: {selected.po_id}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Suggested Suppliers for Sourcing */}
                    {selected.suggested_suppliers.length > 0 && (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-subtle)', marginBottom: 6 }}>
                          RANKED SUGGESTED SUPPLIERS ({selected.suggested_suppliers.length})
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {selected.suggested_suppliers.map((s, idx) => (
                            <div
                              key={s.supplier_id}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                padding: '7px 10px',
                                border: '1px solid var(--border)',
                                borderRadius: 7,
                                fontSize: 12.5
                              }}
                            >
                              <div>
                                <strong>#{idx + 1} {s.supplier_id}</strong> — {s.name}
                                <span className="badge badge-neutral" style={{ marginLeft: 6 }}>
                                  {s.source}
                                </span>
                              </div>
                              <div style={{ color: 'var(--text-muted)' }}>
                                On-time {s.on_time_pct}% · Quality {s.quality_rating}/5
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Preferred Supplier Score Breakdown */}
                    {selected.preferred_supplier_breakdown.length > 0 && (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-subtle)', marginBottom: 6 }}>
                          PREFERRED SUPPLIER RANKING EXPLAINABILITY (AS OF {selected.first_created_at.slice(0, 10)})
                        </div>
                        {selected.preferred_supplier_breakdown.slice(0, 3).map((p) => (
                          <div
                            key={p.supplier_id}
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 7,
                              padding: '8px 10px',
                              marginBottom: 6,
                              fontSize: 12
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                              <strong>
                                Rank #{p.rank}: {p.supplier_id} ({p.supplier_name})
                              </strong>
                              <span>
                                Score <strong>{p.composite_score.toFixed(1)}/100</strong> · Ref{' '}
                                <span className="mono">₹{p.reference_price.toFixed(2)}</span>
                              </span>
                            </div>
                            <div style={{ color: 'var(--text-subtle)', fontSize: 11.5 }}>
                              Contract: {p.breakdown.contract_score} · Volume ({p.breakdown.po_count_548d} POs):{' '}
                              {p.breakdown.volume_score} · Recency: {p.breakdown.recency_score} · Quality (
                              {p.breakdown.quality_rating}/5): {p.breakdown.quality_score} · On-time (
                              {p.breakdown.on_time_pct}%): {p.breakdown.on_time_score}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Clubbed PR Lines */}
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-subtle)', marginBottom: 6 }}>
                        INCLUDED PR LINES ({selected.lines.length})
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>PR / Line</th>
                              <th>Created</th>
                              <th>Qty</th>
                              <th>Need-by</th>
                              <th>Requester</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selected.lines.map((l) => (
                              <tr key={`${l.pr_no}-${l.pr_line}`}>
                                <td className="mono">{l.pr_no}/{l.pr_line}</td>
                                <td style={{ whiteSpace: 'nowrap' }}>{l.created_at}</td>
                                <td>{l.quantity}</td>
                                <td style={{ whiteSpace: 'nowrap' }}>{l.need_by_date}</td>
                                <td>{l.requester}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {subTab === 'orders' && (
        <div className="split-grid">
          <div className="card">
            <div className="card-header">
              <h2>Approved Purchase Orders ({orders.purchase_orders.length})</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>PO Ref</th>
                    <th>Supplier</th>
                    <th>Plant</th>
                    <th>Route</th>
                    <th>Value</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.purchase_orders.map((po) => (
                    <tr key={String(po.po_ref)}>
                      <td className="mono" style={{ fontWeight: 600 }}>{String(po.po_ref)}</td>
                      <td className="mono">{String(po.supplier_id)}</td>
                      <td>{String(po.plant)}</td>
                      <td><span className={routeBadgeClass(String(po.route))}>{String(po.route)}</span></td>
                      <td>{formatInr(Number(po.total_value_inr))}</td>
                      <td style={{ fontSize: 12 }}>{String(po.created_by)}</td>
                    </tr>
                  ))}
                  {orders.purchase_orders.length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-subtle)' }}>No approved POs yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2>Approved Sourcing Requests ({orders.sourcing_requests.length})</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SR Ref</th>
                    <th>Route</th>
                    <th>Item</th>
                    <th>Value</th>
                    <th>Suggested</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.sourcing_requests.map((sr) => (
                    <tr key={String(sr.sr_ref)}>
                      <td className="mono" style={{ fontWeight: 600 }}>{String(sr.sr_ref)}</td>
                      <td><span className={routeBadgeClass(String(sr.route))}>{String(sr.route)}</span></td>
                      <td className="mono">{String(sr.item_code)}</td>
                      <td>{formatInr(Number(sr.estimated_value_inr))}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{String(sr.suggested_supplier_ids || '—')}</td>
                    </tr>
                  ))}
                  {orders.sourcing_requests.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-subtle)' }}>No approved sourcing requests yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {subTab === 'audit' && (
        <div className="card">
          <div className="card-header">
            <h2>Immutable Governance & Override Audit Trail</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Actor</th>
                  <th>Entity</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log) => (
                  <tr key={log.log_id}>
                    <td className="mono" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                      {log.timestamp.replace('T', ' ').slice(0, 19)}
                    </td>
                    <td style={{ fontWeight: 600 }}>{log.actor}</td>
                    <td className="mono">{log.entity_type} · {log.entity_id}</td>
                    <td><span className="badge badge-neutral">{log.action}</span></td>
                    <td className="mono" style={{ fontSize: 11.5, maxWidth: 460, wordBreak: 'break-word' }}>
                      {JSON.stringify(log.details)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Override Modal */}
      {overrideOpen && selected && (
        <div className="modal-backdrop" onClick={() => setOverrideOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <h2>Override Decision — {selected.group_id}</h2>
              <button className="btn btn-secondary btn-sm" onClick={() => setOverrideOpen(false)}>
                Close
              </button>
            </div>
            <form className="card-body" onSubmit={handleOverrideSubmit}>
              <div className="alert alert-info">
                <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                Policy Clause 8.1: The original system decision (<strong>{selected.route}</strong>) is kept in the audit log alongside your written justification.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>New Decision</label>
                  <select
                    className="select"
                    value={overrideDecision}
                    onChange={(e) => {
                      const d = e.target.value as 'PO' | 'SOURCING_REQUEST' | 'NOT_PROCESSED';
                      setOverrideDecision(d);
                      setOverrideRoute(d === 'PO' ? 'SPOT_PO' : d === 'SOURCING_REQUEST' ? 'RFQ' : 'NOT_PROCESSED');
                    }}
                  >
                    <option value="PO">PO</option>
                    <option value="SOURCING_REQUEST">SOURCING_REQUEST</option>
                    <option value="NOT_PROCESSED">NOT_PROCESSED</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>New Route</label>
                  <select
                    className="select"
                    value={overrideRoute}
                    onChange={(e) => setOverrideRoute(e.target.value)}
                  >
                    <option value="CONTRACT_PO">CONTRACT_PO</option>
                    <option value="SPOT_PO">SPOT_PO</option>
                    <option value="EMERGENCY_PO">EMERGENCY_PO</option>
                    <option value="RFQ">RFQ</option>
                    <option value="RFP">RFP</option>
                    <option value="CAPEX_SOURCING">CAPEX_SOURCING</option>
                    <option value="NEW_ITEM_SOURCING">NEW_ITEM_SOURCING</option>
                    <option value="NOT_PROCESSED">NOT_PROCESSED</option>
                  </select>
                </div>
              </div>

              {overrideDecision === 'PO' && (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>Active Supplier (Clause 5.7 Enforced)</label>
                  <select
                    className="select"
                    value={overrideSupplier}
                    onChange={(e) => setOverrideSupplier(e.target.value)}
                  >
                    <option value="">Select Active Supplier...</option>
                    {activeSuppliers.map((s) => (
                      <option key={s.supplier_id} value={s.supplier_id}>
                        {s.supplier_id} — {s.name} ({s.city})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, fontWeight: 600 }}>Mandatory Written Comment *</label>
                <textarea
                  className="textarea"
                  rows={3}
                  required
                  placeholder="Explain business reason for overriding the policy decision..."
                  value={overrideComment}
                  onChange={(e) => setOverrideComment(e.target.value)}
                />
              </div>

              <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={submitting}>
                {submitting ? 'Saving Override...' : 'Confirm Override & Log Reason'}
              </button>
            </form>
          </div>
        </div>
      )}

      {loading && <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginTop: 8 }}>Syncing...</div>}
    </div>
  );
};
