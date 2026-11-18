import React, { useRef, useState } from 'react';
import {
  Send,
  Upload,
  CheckCircle2,
  Sparkles,
  Download,
  RefreshCw,
  ArrowRight,
  FileSpreadsheet
} from 'lucide-react';
import { api, BatchProcessResponse, ChatTurnResponse, formatInr } from '../api/client';

interface Props {
  onNavigateWorkspace: (batchId?: number) => void;
  onDataChanged: () => void;
}

const STARTER_PROMPTS = [
  'need 200 nitrile gloves for Chakan by next Friday',
  'need 50 bearings for Bhosari next Monday, normal',
  'need 2 industrial laser printers for Bhosari by 2026-12-05, normal'
];

function renderFormattedText(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export const ChatIntake: React.FC<Props> = ({ onNavigateWorkspace, onDataChanged }) => {
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<
    Array<{ role: 'user' | 'assistant'; content: string }>
  >([
    {
      role: 'assistant',
      content:
        'Hi! Tell me what you need to purchase in plain language (for example: "need 200 nitrile gloves for Chakan by next Friday"). I will match it to Corvo\'s catalog, ask for any missing details, and route it through the active procurement policy.'
    }
  ]);
  const [turn, setTurn] = useState<ChatTurnResponse | null>(null);
  const [input, setInput] = useState('');
  const [requester, setRequester] = useState('A. Kulkarni');
  const [department, setDepartment] = useState('Production');
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [createdPr, setCreatedPr] = useState<{
    pr_no: string;
    group_id: string;
    clubbed_with_existing?: boolean;
    decision: BatchProcessResponse['decisions'][number];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Batch CSV Upload state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingBatch, setUploadingBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchProcessResponse | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  const sendMessage = async (text: string) => {
    const clean = text.trim();
    if (!clean || sending) return;
    setError(null);
    setCreatedPr(null);
    setSending(true);
    setMessages((prev) => [...prev, { role: 'user', content: clean }]);
    setInput('');

    try {
      const res = await api.sendChatMessage({
        session_id: sessionId,
        message: clean
      });
      setSessionId(res.session_id);
      setTurn(res);
      setMessages(res.messages.map((m) => ({ role: m.role, content: m.content })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleConfirmPr = async () => {
    if (!sessionId || confirming) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await api.confirmChatPr({
        session_id: sessionId,
        requester,
        department
      });
      setCreatedPr({
        pr_no: res.pr_no,
        group_id: res.group_id,
        clubbed_with_existing: res.clubbed_with_existing,
        decision: res.decision
      });
      onDataChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create PR');
    } finally {
      setConfirming(false);
    }
  };

  const resetChat = () => {
    setSessionId(undefined);
    setTurn(null);
    setCreatedPr(null);
    setError(null);
    setMessages([
      {
        role: 'assistant',
        content:
          'Started a fresh requisition chat. Tell me what item, quantity, plant, and need-by date you need.'
      }
    ]);
  };

  const handleBatchUpload = async (file: File) => {
    setUploadingBatch(true);
    setBatchError(null);
    try {
      const res = await api.processBatchFile(file);
      setBatchResult(res);
      onDataChanged();
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : 'Failed to process batch CSV');
    } finally {
      setUploadingBatch(false);
    }
  };

  const handleRunSampleBatch = async () => {
    setUploadingBatch(true);
    setBatchError(null);
    try {
      const res = await api.processSampleBatch();
      setBatchResult(res);
      onDataChanged();
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : 'Failed to process sample batch');
    } finally {
      setUploadingBatch(false);
    }
  };

  const slots = turn?.slots;

  return (
    <div className="split-grid">
      {/* Left: Conversational PR Intake */}
      <div className="card">
        <div className="card-header">
          <div>
            <h2>Conversational PR Intake</h2>
            <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginTop: 2 }}>
              Natural-language slot extraction + deterministic catalog matching (zero hallucinated codes)
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={resetChat}>
            <RefreshCw size={14} /> New Request
          </button>
        </div>

        {/* Live Slot Progress Bar */}
        <div className="slot-pills">
          <span className={`slot-pill ${slots?.resolved_item_code ? 'filled' : ''}`}>
            Item: {slots?.resolved_item_code ? `${slots.resolved_item_code}` : '—'}
          </span>
          <span className={`slot-pill ${slots?.quantity ? 'filled' : ''}`}>
            Qty: {slots?.quantity ? `${slots.quantity} ${slots.uom || ''}` : '—'}
          </span>
          <span className={`slot-pill ${slots?.plant ? 'filled' : ''}`}>
            Plant: {slots?.plant || '—'}
          </span>
          <span className={`slot-pill ${slots?.need_by_date ? 'filled' : ''}`}>
            Need-by: {slots?.need_by_date || '—'}
          </span>
          <span className={`slot-pill ${slots?.urgency ? 'filled' : ''}`}>
            Urgency: {slots?.urgency || '—'}
          </span>
          {slots?.item_match_status === 'NEW_ITEM' && (
            <span className={`slot-pill ${slots?.estimated_unit_price ? 'filled' : ''}`}>
              Est. Price: {slots?.estimated_unit_price ? formatInr(slots.estimated_unit_price) : '—'}
            </span>
          )}
          {turn && (
            <span className="slot-pill" style={{ marginLeft: 'auto' }}>
              <Sparkles size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
              {turn.used_ai ? 'Groq NLU + Deterministic Matcher' : 'Deterministic NLU Mode'}
            </span>
          )}
        </div>

        <div className="chat-box">
          <div className="chat-messages">
            {messages.map((m, idx) => (
              <div key={idx} className={`msg-bubble ${m.role}`}>
                {renderFormattedText(m.content)}
              </div>
            ))}
            {sending && <div className="msg-bubble assistant">Thinking...</div>}
          </div>

          {/* Starter prompts when empty */}
          {!turn && (
            <div className="chip-row">
              {STARTER_PROMPTS.map((p) => (
                <button key={p} className="chip-btn" onClick={() => sendMessage(p)}>
                  “{p}”
                </button>
              ))}
            </div>
          )}

          {/* Quick replies & ambiguous item disambiguation chips */}
          {turn && !turn.ready_to_confirm && turn.quick_replies.length > 0 && (
            <div className="chip-row">
              {turn.quick_replies.map((qr) => (
                <button key={qr} className="chip-btn" onClick={() => sendMessage(qr)}>
                  {qr}
                </button>
              ))}
            </div>
          )}

          {/* Confirmation Card when all slots are complete */}
          {turn?.ready_to_confirm && !createdPr && slots && (
            <div
              style={{
                padding: '14px 16px',
                borderTop: '1px solid #a7f3d0',
                background: 'var(--emerald-soft)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ color: 'var(--emerald)', fontSize: 13.5 }}>
                  Ready to Raise Purchase Requisition
                </strong>
                <span className="badge badge-po">All Slots Verified</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Requester</label>
                  <input
                    className="input"
                    value={requester}
                    onChange={(e) => setRequester(e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Department</label>
                  <input
                    className="input"
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                  />
                </div>
              </div>
              <button
                className="btn btn-emerald"
                style={{ width: '100%' }}
                onClick={handleConfirmPr}
                disabled={confirming}
              >
                <CheckCircle2 size={16} />
                {confirming ? 'Creating PR & Evaluating Policy...' : 'Confirm & Create PR'}
              </button>
            </div>
          )}

          {/* Live Created PR Decision Card */}
          {createdPr && (
            <div
              style={{
                padding: '14px 16px',
                borderTop: '1px solid #bfdbfe',
                background: 'var(--primary-soft)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ color: 'var(--primary)', fontSize: 14 }}>
                    {createdPr.pr_no} Created → {createdPr.decision.route}
                  </strong>
                  {createdPr.clubbed_with_existing && (
                    <span className="badge badge-emergency" style={{ marginLeft: 8 }}>
                      Clubbed into {createdPr.group_id} (Clause 2)
                    </span>
                  )}
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>
                    {createdPr.decision.resolved_item_code} · Value{' '}
                    <strong>{formatInr(createdPr.decision.group_value_inr)}</strong> · Policy{' '}
                    {createdPr.decision.policy_version}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginTop: 4 }}>
                    {createdPr.decision.reason}
                  </div>
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => onNavigateWorkspace()}
                >
                  Open in Workspace <ArrowRight size={14} />
                </button>
              </div>
            </div>
          )}

          {error && (
            <div style={{ padding: '8px 16px' }}>
              <div className="alert alert-error" style={{ marginBottom: 0 }}>
                {error}
              </div>
            </div>
          )}

          <form
            className="chat-input-bar"
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
          >
            <input
              className="input"
              placeholder='Type your request (e.g. "need 200 nitrile gloves for Chakan by next Friday")...'
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={sending}
            />
            <button type="submit" className="btn btn-primary" disabled={sending || !input.trim()}>
              <Send size={15} /> Send
            </button>
          </form>
        </div>
      </div>

      {/* Right: PR Batch CSV Upload & Run 1 / Run 2 Center */}
      <div className="card">
        <div className="card-header">
          <div>
            <h2>PR Batch CSV Processor</h2>
            <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginTop: 2 }}>
              Upload a PR batch CSV to run the full policy engine and export Section 4 decisions
            </div>
          </div>
          <FileSpreadsheet size={18} color="var(--primary)" />
        </div>
        <div className="card-body">
          <div
            style={{
              border: '2px dashed var(--border-strong)',
              borderRadius: 10,
              padding: '24px 18px',
              textAlign: 'center',
              background: '#f8fafc',
              marginBottom: 16
            }}
          >
            <Upload size={26} color="var(--primary)" style={{ marginBottom: 8 }} />
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
              Drop or select a PR Batch CSV
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-subtle)', marginBottom: 14 }}>
              Matches <code>sample_pr_batch.csv</code> format · Safe to re-run after policy amendments
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleBatchUpload(file);
                e.target.value = '';
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingBatch}
              >
                <Upload size={15} />
                {uploadingBatch ? 'Processing Batch...' : 'Upload PR Batch CSV'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleRunSampleBatch}
                disabled={uploadingBatch}
              >
                Run Kit Sample Batch (186 PRs)
              </button>
            </div>
          </div>

          {batchError && <div className="alert alert-error">{batchError}</div>}

          {batchResult && (
            <div>
              <div className="alert alert-success">
                Processed <strong>{batchResult.filename}</strong> ({batchResult.summary.total_lines}{' '}
                lines) under <strong>{batchResult.policy_version}</strong>.
              </div>

              <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 14 }}>
                <div className="kpi-card">
                  <div className="kpi-label">Requirements</div>
                  <div className="kpi-value">{batchResult.summary.requirements_count}</div>
                  <div className="kpi-sub">Clubbed from {batchResult.summary.total_lines} PR lines</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Consolidated POs</div>
                  <div className="kpi-value">{batchResult.summary.consolidated_po_count}</div>
                  <div className="kpi-sub">24-hr consolidation (Sec 7)</div>
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-subtle)', marginBottom: 8 }}>
                  ROUTE BREAKDOWN (BY PR LINE)
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                  {Object.entries(batchResult.summary.route_counts).map(([route, cnt]) => (
                    <span key={route} className="badge badge-neutral">
                      {route}: <strong>{cnt}</strong>
                    </span>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <a
                  href={`/api/export-decisions?batch_id=${batchResult.batch_id}`}
                  className="btn btn-emerald"
                  style={{ flex: 1, textDecoration: 'none' }}
                >
                  <Download size={15} /> Export Decisions CSV
                </a>
                <button
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => onNavigateWorkspace(batchResult.batch_id)}
                >
                  Review in Workspace <ArrowRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
