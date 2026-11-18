import React, { useEffect, useRef, useState } from 'react';
import { Upload, Sparkles, CheckCircle2, Trash2, Code2, ShieldCheck, RotateCcw } from 'lucide-react';
import { api, PolicyDto } from '../api/client';

function safeParseSummaryDiff(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

interface Props {
  onPolicyActivated: () => void;
}

const EXAMPLE_AMENDMENTS = [
  'Policy Version 5.1 effective 2026-11-01: For Chakan (CHK1), raise the Spot PO limit to ₹3,00,000.',
  'Policy Version 5.1 effective 2026-11-01: For Testing & Calibration category, increase Spot PO limit to ₹4,00,000 and set Emergency PO limit to ₹6,00,000.'
];

export const PolicyStudio: React.FC<Props> = ({ onPolicyActivated }) => {
  const [policies, setPolicies] = useState<PolicyDto[]>([]);
  const [activePolicy, setActivePolicy] = useState<PolicyDto | null>(null);
  const [mode, setMode] = useState<'chat' | 'file'>('file');
  const [instruction, setInstruction] = useState('');
  const [approver, setApprover] = useState('Head of Procurement');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [draft, setDraft] = useState<PolicyDto | null>(null);
  const [diffSummary, setDiffSummary] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [usedAi, setUsedAi] = useState<boolean>(false);

  // Editable JSON & macro override for blind-test precision
  const [editJsonOpen, setEditJsonOpen] = useState(false);
  const [draftEffectiveDate, setDraftEffectiveDate] = useState('');
  const [draftVersion, setDraftVersion] = useState('');
  const [draftClubDays, setDraftClubDays] = useState(14);
  const [draftNeedByDays, setDraftNeedByDays] = useState(7);
  const [draftConsolHours, setDraftConsolHours] = useState(24);
  const [draftHistoryDays, setDraftHistoryDays] = useState(365);
  const [draftPslDays, setDraftPslDays] = useState(548);
  const [draftRulesJson, setDraftRulesJson] = useState('');

  const fileRef = useRef<HTMLInputElement | null>(null);

  const loadPolicies = async () => {
    try {
      const res = await api.getPolicies();
      setPolicies(res.policies);
      setActivePolicy(res.active_policy);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load policies');
    }
  };

  useEffect(() => {
    loadPolicies();
  }, []);

  const populateDraft = (
    p: PolicyDto,
    summary: string[],
    aiFlag: boolean,
    warns: string[]
  ) => {
    setDraft(p);
    setDiffSummary(summary);
    setUsedAi(aiFlag);
    setWarnings(warns);
    setDraftVersion(p.version);
    setDraftEffectiveDate(p.effective_date);
    setDraftClubDays(p.clubbing_creation_window_days);
    setDraftNeedByDays(p.clubbing_need_by_window_days);
    setDraftConsolHours(p.po_consolidation_window_hours);
    setDraftHistoryDays(p.active_history_lookback_days);
    setDraftPslDays(p.psl_lookback_days ?? 548);
    setDraftRulesJson(JSON.stringify(p.rules, null, 2));
    setEditJsonOpen(false);
  };

  const handleChatAmend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!instruction.trim()) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.amendPolicyByChat(instruction, approver);
      populateDraft(
        res.draft_policy,
        res.diff.plain_language_summary,
        res.used_ai,
        res.warnings
      );
      await loadPolicies();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse policy change');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileAmend = async (file: File) => {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.amendPolicyByFile(file, approver);
      populateDraft(
        res.draft_policy,
        res.diff.plain_language_summary,
        res.used_ai,
        res.warnings
      );
      await loadPolicies();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse amendment document');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveEdits = async (): Promise<boolean> => {
    if (!draft) return false;
    setError(null);
    try {
      const parsedRules = JSON.parse(draftRulesJson);
      const res = await api.updateDraftPolicy(draft.policy_id, {
        version: draftVersion,
        effective_date: draftEffectiveDate,
        clubbing_creation_window_days: Number(draftClubDays),
        clubbing_need_by_window_days: Number(draftNeedByDays),
        po_consolidation_window_hours: Number(draftConsolHours),
        active_history_lookback_days: Number(draftHistoryDays),
        psl_lookback_days: Number(draftPslDays),
        rules: parsedRules
      });
      setDraft(res.draft_policy);
      const summary = safeParseSummaryDiff(res.draft_policy.summary_diff);
      setDiffSummary(summary.length > 0 ? summary : diffSummary);
      setEditJsonOpen(false);
      setSuccess('Draft rules updated & schema-validated. Review and click Approve & Activate.');
      await loadPolicies();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON or rule schema');
      return false;
    }
  };

  const handleActivate = async (policyId: number) => {
    setSubmitting(true);
    setError(null);
    try {
      if (editJsonOpen && draft && policyId === draft.policy_id) {
        const saved = await handleSaveEdits();
        if (!saved) return;
      }
      const res = await api.activatePolicy(policyId, approver);
      setDraft(null);
      setDiffSummary([]);
      setSuccess(res.message);
      await loadPolicies();
      onPolicyActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDiscard = async (policyId: number) => {
    setError(null);
    try {
      await api.deleteDraftPolicy(policyId);
      setDraft(null);
      setDiffSummary([]);
      await loadPolicies();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discard draft policy');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {/* Top Row: Propose Amendment + Active Policy Summary */}
      <div className="split-grid">
        {/* Propose New Policy / Amendment */}
        <div className="card">
          <div className="card-header">
            <div>
              <h2>Update Policy Without Code Changes</h2>
              <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginTop: 2 }}>
                Upload an amendment document (PDF/TXT/MD) or describe rule changes in plain English
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className={`btn btn-sm ${mode === 'file' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setMode('file')}
              >
                Upload Document
              </button>
              <button
                className={`btn btn-sm ${mode === 'chat' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setMode('chat')}
              >
                Describe in Chat
              </button>
            </div>
          </div>
          <div className="card-body">
            {mode === 'file' ? (
              <div
                style={{
                  border: '2px dashed var(--border-strong)',
                  borderRadius: 10,
                  padding: 24,
                  textAlign: 'center',
                  background: '#f8fafc'
                }}
              >
                <Upload size={24} color="var(--primary)" style={{ marginBottom: 8 }} />
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                  Upload Policy Amendment PDF, TXT, or Markdown
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-subtle)', marginBottom: 14 }}>
                  Groq AI extracts rule deltas, plant-specific overrides, category limits, and effective dates into a preview diff
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf,.txt,.md,application/pdf,text/plain"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileAmend(f);
                    e.target.value = '';
                  }}
                />
                <button
                  className="btn btn-primary"
                  onClick={() => fileRef.current?.click()}
                  disabled={submitting}
                >
                  <Sparkles size={15} />
                  {submitting ? 'Reading Amendment & Computing Diff...' : 'Upload Amendment & Preview Diff'}
                </button>
              </div>
            ) : (
              <form onSubmit={handleChatAmend}>
                <textarea
                  className="textarea"
                  rows={4}
                  placeholder='Describe the policy change (e.g. "Effective 2026-11-10, for CHK1 plant lower the Spot PO limit to ₹1,50,000 and add a rule requiring RFQ for IT equipment over ₹1,00,000")...'
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0 12px' }}>
                  {EXAMPLE_AMENDMENTS.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      className="chip-btn"
                      onClick={() => setInstruction(ex)}
                    >
                      Try: {ex.slice(0, 62)}...
                    </button>
                  ))}
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ width: '100%' }}
                  disabled={submitting || !instruction.trim()}
                >
                  <Sparkles size={15} />
                  {submitting ? 'Compiling Policy AST & Diff...' : 'Generate Plain-Language Diff'}
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Active Policy Snapshot */}
        {activePolicy && (
          <div className="card">
            <div className="card-header">
              <div>
                <h2>Active Policy: v{activePolicy.version}</h2>
                <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginTop: 2 }}>
                  Effective {activePolicy.effective_date} · Approved by {activePolicy.approved_by || 'System'}
                </div>
              </div>
              <span className="badge badge-po">
                <ShieldCheck size={13} /> ACTIVE
              </span>
            </div>
            <div className="card-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
                <div className="kpi-card" style={{ padding: 11 }}>
                  <div className="kpi-label">Clubbing Windows</div>
                  <div style={{ fontWeight: 700, marginTop: 4 }}>
                    {activePolicy.clubbing_creation_window_days}d created / ±{activePolicy.clubbing_need_by_window_days}d need-by
                  </div>
                </div>
                <div className="kpi-card" style={{ padding: 11 }}>
                  <div className="kpi-label">PO Consolidation</div>
                  <div style={{ fontWeight: 700, marginTop: 4 }}>
                    {activePolicy.po_consolidation_window_hours} hours window
                  </div>
                </div>
                <div className="kpi-card" style={{ padding: 11 }}>
                  <div className="kpi-label">Active History Lookback</div>
                  <div style={{ fontWeight: 700, marginTop: 4 }}>
                    {activePolicy.active_history_lookback_days} days
                  </div>
                </div>
                <div className="kpi-card" style={{ padding: 11 }}>
                  <div className="kpi-label">Ordered Waterfall Rules</div>
                  <div style={{ fontWeight: 700, marginTop: 4 }}>
                    {activePolicy.rules.length} active clauses
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Pending Draft Plain-Language Diff & Approval Card */}
      {draft && (
        <div className="card" style={{ border: '2px solid var(--primary)' }}>
          <div className="card-header" style={{ background: 'var(--primary-soft)' }}>
            <div>
              <h2 style={{ color: 'var(--primary)' }}>
                Draft Policy Preview: v{draft.version} (Effective {draft.effective_date})
              </h2>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                {usedAi ? 'Parsed by Groq LLM + Zod AST validated' : 'Parsed by deterministic fallback + Zod AST validated'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setEditJsonOpen(!editJsonOpen)}
              >
                <Code2 size={14} /> {editJsonOpen ? 'Hide Rule Editor' : 'Edit Rules / Date'}
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => handleDiscard(draft.policy_id)}
              >
                <Trash2 size={14} /> Reject
              </button>
            </div>
          </div>
          <div className="card-body">
            {warnings.length > 0 && (
              <div className="alert alert-warn">{warnings.join(' · ')}</div>
            )}

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-subtle)', marginBottom: 6 }}>
                WHAT WILL CHANGE (PLAIN-LANGUAGE DIFF)
              </div>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13.5 }}>
                {diffSummary.map((line, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{line}</li>
                ))}
              </ul>
            </div>

            {editJsonOpen && (
              <div
                style={{
                  background: '#f8fafc',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 14,
                  marginBottom: 16
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600 }}>Version</label>
                    <input
                      className="input"
                      value={draftVersion}
                      onChange={(e) => setDraftVersion(e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600 }}>Effective Date (YYYY-MM-DD)</label>
                    <input
                      className="input"
                      value={draftEffectiveDate}
                      onChange={(e) => setDraftEffectiveDate(e.target.value)}
                    />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 10 }}>
                  <div>
                    <label style={{ fontSize: 11.5, fontWeight: 600 }}>Clubbing Created (d)</label>
                    <input
                      type="number"
                      className="input"
                      value={draftClubDays}
                      onChange={(e) => setDraftClubDays(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 11.5, fontWeight: 600 }}>Clubbing Need-by (±d)</label>
                    <input
                      type="number"
                      className="input"
                      value={draftNeedByDays}
                      onChange={(e) => setDraftNeedByDays(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 11.5, fontWeight: 600 }}>PO Consolid. (hrs)</label>
                    <input
                      type="number"
                      className="input"
                      value={draftConsolHours}
                      onChange={(e) => setDraftConsolHours(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 11.5, fontWeight: 600 }}>History Lookback (d)</label>
                    <input
                      type="number"
                      className="input"
                      value={draftHistoryDays}
                      onChange={(e) => setDraftHistoryDays(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 11.5, fontWeight: 600 }}>PSL Lookback (d)</label>
                    <input
                      type="number"
                      className="input"
                      value={draftPslDays}
                      onChange={(e) => setDraftPslDays(Number(e.target.value))}
                    />
                  </div>
                </div>
                <label style={{ fontSize: 12, fontWeight: 600 }}>Declarative Rules AST JSON</label>
                <textarea
                  className="textarea mono"
                  rows={12}
                  style={{ fontSize: 12 }}
                  value={draftRulesJson}
                  onChange={(e) => setDraftRulesJson(e.target.value)}
                />
                <button
                  className="btn btn-secondary btn-sm"
                  style={{ marginTop: 10 }}
                  onClick={handleSaveEdits}
                >
                  Save & Re-validate Draft Rules
                </button>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                className="input"
                style={{ maxWidth: 240 }}
                value={approver}
                onChange={(e) => setApprover(e.target.value)}
                placeholder="Approved by..."
              />
              <button
                className="btn btn-emerald"
                style={{ flex: 1 }}
                disabled={submitting}
                onClick={() => handleActivate(draft.policy_id)}
              >
                <CheckCircle2 size={16} />
                Approve & Activate Policy v{draft.version} from {draft.effective_date}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Active Policy Declarative Rules Table */}
      {activePolicy && (
        <div className="card">
          <div className="card-header">
            <h2>Active Waterfall Rules (Policy v{activePolicy.version} — Stored as Data)</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Clause</th>
                  <th>Rule Name</th>
                  <th>AST Conditions</th>
                  <th>Outcome / Route</th>
                  <th>Supplier Strategy</th>
                </tr>
              </thead>
              <tbody>
                {activePolicy.rules.map((r) => (
                  <tr key={`${r.priority_order}-${r.clause_number}`}>
                    <td style={{ fontWeight: 700 }}>{r.priority_order}</td>
                    <td className="mono">{r.clause_number}</td>
                    <td style={{ fontWeight: 600 }}>{r.rule_name}</td>
                    <td className="mono" style={{ fontSize: 11.5, maxWidth: 420, wordBreak: 'break-word' }}>
                      {JSON.stringify(r.conditions)}
                    </td>
                    <td>
                      <span className={`badge ${r.outcome === 'PO' ? 'badge-po' : 'badge-sourcing'}`}>
                        {r.route}
                      </span>
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {r.supplier_strategy}
                      {r.supplier_suggestion_count > 0 ? ` (top ${r.supplier_suggestion_count})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Version History */}
      <div className="card">
        <div className="card-header">
          <h2>Policy Version History ({policies.length})</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Effective Date</th>
                <th>Status</th>
                <th>Approved By</th>
                <th>Rules</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.policy_id}>
                  <td className="mono" style={{ fontWeight: 700 }}>v{p.version}</td>
                  <td className="mono">{p.effective_date}</td>
                  <td>
                    <span
                      className={`badge ${
                        p.status === 'ACTIVE'
                          ? 'badge-po'
                          : p.status === 'DRAFT'
                            ? 'badge-emergency'
                            : p.status === 'ROLLED_BACK'
                              ? 'badge-error'
                              : 'badge-neutral'
                      }`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td>{p.approved_by || '—'}</td>
                  <td>{p.rules.length} clauses</td>
                  <td>
                    {p.status === 'DRAFT' ? (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() =>
                          populateDraft(
                            p,
                            safeParseSummaryDiff(p.summary_diff),
                            false,
                            []
                          )
                        }
                      >
                        Review Draft
                      </button>
                    ) : p.status === 'ACTIVE' ? (
                      <span style={{ fontSize: 12, color: 'var(--emerald)', fontWeight: 600 }}>Live</span>
                    ) : (
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={submitting}
                        onClick={() => handleActivate(p.policy_id)}
                      >
                        <RotateCcw size={13} /> Rollback / Activate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
