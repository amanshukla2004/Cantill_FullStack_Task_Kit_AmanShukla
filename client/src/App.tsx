import React, { useEffect, useState } from 'react';
import {
  MessageSquarePlus,
  ClipboardCheck,
  Shield,
  FileSignature,
  Award,
  Factory
} from 'lucide-react';
import { api, HealthResponse, MasterDataResponse } from './api/client';
import { ChatIntake } from './components/ChatIntake';
import { BuyerWorkspace } from './components/BuyerWorkspace';
import { PolicyStudio } from './components/PolicyStudio';
import { ContractManager } from './components/ContractManager';
import { PreferredSuppliers } from './components/PreferredSuppliers';

type TabKey = 'intake' | 'workspace' | 'policy' | 'contracts' | 'suppliers';

const PAGE_META: Record<TabKey, { title: string; subtitle: string }> = {
  intake: {
    title: 'PR Intake & Batch Processing',
    subtitle: 'Raise purchase requests via chat or process a PR batch CSV against the active policy'
  },
  workspace: {
    title: 'Buyer Decision Workspace',
    subtitle: 'Inspect clubbed requirements, policy citations, approve POs/RFQs, or override with audit trail'
  },
  policy: {
    title: 'Policy-as-Data Studio',
    subtitle: 'Versioned procurement rules with plain-language diff previews and zero-code activation'
  },
  contracts: {
    title: 'Rate Contracts & Signed PDFs',
    subtitle: 'Monitor contract ceilings and ingest signed post-register PDF contracts'
  },
  suppliers: {
    title: 'Preferred Supplier Lists (Section 6)',
    subtitle: 'Explainable 5-factor supplier rankings recalculated as of any date with top-3 CSV export'
  }
};

export const App: React.FC = () => {
  const [tab, setTab] = useState<TabKey>('intake');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [masterData, setMasterData] = useState<MasterDataResponse | null>(null);
  const [workspaceBatchId, setWorkspaceBatchId] = useState<number | undefined>(undefined);
  const [refreshTick, setRefreshTick] = useState(0);

  const loadGlobal = async () => {
    try {
      const [h, m] = await Promise.all([api.getHealth(), api.getMasterData()]);
      setHealth(h);
      setMasterData(m);
    } catch {
      // ignore initial transient errors
    }
  };

  useEffect(() => {
    loadGlobal();
  }, [refreshTick]);

  const bumpRefresh = () => {
    setWorkspaceBatchId(undefined);
    setRefreshTick((t) => t + 1);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">
            <div className="brand-logo">
              <Factory size={17} />
            </div>
            Corvo PR-to-PO
          </div>
          <div className="brand-sub">Policy-Driven Procurement Engine</div>
        </div>

        <nav className="nav-list">
          <button
            className={`nav-btn ${tab === 'intake' ? 'active' : ''}`}
            onClick={() => setTab('intake')}
          >
            <MessageSquarePlus size={17} /> Chat Intake & Batch
          </button>
          <button
            className={`nav-btn ${tab === 'workspace' ? 'active' : ''}`}
            onClick={() => setTab('workspace')}
          >
            <ClipboardCheck size={17} /> Buyer Workspace
          </button>
          <button
            className={`nav-btn ${tab === 'policy' ? 'active' : ''}`}
            onClick={() => setTab('policy')}
          >
            <Shield size={17} /> Policy Studio
          </button>
          <button
            className={`nav-btn ${tab === 'contracts' ? 'active' : ''}`}
            onClick={() => setTab('contracts')}
          >
            <FileSignature size={17} /> Rate Contracts
          </button>
          <button
            className={`nav-btn ${tab === 'suppliers' ? 'active' : ''}`}
            onClick={() => setTab('suppliers')}
          >
            <Award size={17} /> Preferred Suppliers
          </button>
        </nav>

        <div className="sidebar-footer">
          <div>
            <span className="status-dot green" />
            Policy: <strong>{health?.active_policy_version || 'v5.0'}</strong>
          </div>
          <div>
            <span className={`status-dot ${health?.groq_configured ? 'green' : 'amber'}`} />
            {health?.groq_configured ? 'Groq AI Live' : 'Deterministic Fallback'}
          </div>
          {health && (
            <div style={{ fontSize: 11, color: '#64748b' }}>
              {health.counts.items} items · {health.counts.suppliers} vendors · {health.counts.contracts} contracts
            </div>
          )}
        </div>
      </aside>

      <div className="main-content">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{PAGE_META[tab].title}</h1>
            <p>{PAGE_META[tab].subtitle}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="badge badge-po">
              Active Policy {health?.active_policy_version || 'v5.0'}
            </span>
            <span className="badge badge-neutral">Plants: PUN1 · CHK1</span>
          </div>
        </header>

        <main className="page-body">
          {tab === 'intake' && (
            <ChatIntake
              onNavigateWorkspace={(batchId) => {
                setWorkspaceBatchId(batchId);
                setTab('workspace');
              }}
              onDataChanged={bumpRefresh}
            />
          )}
          {tab === 'workspace' && (
            <BuyerWorkspace
              initialBatchId={workspaceBatchId}
              masterData={masterData}
              refreshTick={refreshTick}
            />
          )}
          {tab === 'policy' && <PolicyStudio onPolicyActivated={bumpRefresh} />}
          {tab === 'contracts' && (
            <ContractManager masterData={masterData} onDataChanged={bumpRefresh} />
          )}
          {tab === 'suppliers' && <PreferredSuppliers />}
        </main>
      </div>
    </div>
  );
};
