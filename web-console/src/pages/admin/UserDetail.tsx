import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { admin, AdminUser } from '../../lib/api';

function formatDate(dateStr?: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function formatDateTime(dateStr?: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function UserDetail() {
  const { userId } = useParams<{ userId: string }>();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Editable quota state
  const [quota, setQuota] = useState({
    maxBots: 0,
    maxGroupsPerBot: 0,
    maxTasksPerBot: 0,
    maxConcurrentAgents: 0,
    maxMonthlyTokens: 0,
  });
  const [plan, setPlan] = useState<string>('free');

  useEffect(() => {
    if (!userId) return;
    admin.getUser(userId)
      .then((u) => {
        setUser(u);
        setQuota(u.quota);
        setPlan(u.plan);
      })
      .catch((err) => console.error('Failed to load user:', err))
      .finally(() => setLoading(false));
  }, [userId]);

  async function saveQuota() {
    if (!userId) return;
    setSaving(true);
    setMessage('');
    try {
      await admin.updateQuota(userId, quota);
      setMessage('Quota updated successfully.');
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  async function savePlan() {
    if (!userId) return;
    setSaving(true);
    setMessage('');
    try {
      await admin.updatePlan(userId, plan);
      setMessage('Plan updated successfully.');
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;
  if (!user) return <div className="text-center py-12 text-slate-400">User not found.</div>;

  const quotaFields = [
    { key: 'maxBots' as const, label: 'Max Bots' },
    { key: 'maxGroupsPerBot' as const, label: 'Max Groups per Bot' },
    { key: 'maxTasksPerBot' as const, label: 'Max Tasks per Bot' },
    { key: 'maxConcurrentAgents' as const, label: 'Max Concurrent Agents' },
    { key: 'maxMonthlyTokens' as const, label: 'Max Monthly Tokens' },
  ];

  return (
    <div className="animate-fade-in">
      <Link to="/admin/users" className="inline-flex items-center gap-1.5 text-sm text-accent-600 hover:text-accent-500 font-medium mb-4">
        <ArrowLeft className="h-4 w-4" />
        Back to Users
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">{user.email || user.userId}</h1>

      {message && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${message.startsWith('Error') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
          {message}
        </div>
      )}

      {/* User Info */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">User Info</h2>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-slate-500">User ID</dt><dd className="font-mono text-slate-900">{user.userId}</dd></div>
          <div><dt className="text-slate-500">Email</dt><dd className="text-slate-900">{user.email}</dd></div>
          <div><dt className="text-slate-500">Created</dt><dd className="text-slate-900">{formatDateTime(user.createdAt)}</dd></div>
          <div><dt className="text-slate-500">Last Login</dt><dd className="text-slate-900">{formatDateTime(user.lastLogin)}</dd></div>
        </dl>
      </div>

      {/* Usage Stats */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Usage ({user.usageMonth})</h2>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-slate-500">Tokens</dt>
            <dd className="text-2xl font-bold text-slate-900">{user.usageTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Invocations</dt>
            <dd className="text-2xl font-bold text-slate-900">{user.usageInvocations.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Bots</dt>
            <dd className="text-2xl font-bold text-slate-900">{(user.botCount ?? 0).toLocaleString()} / {user.quota?.maxBots?.toLocaleString() ?? '—'}</dd>
          </div>
        </dl>
      </div>

      {/* Plan */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Plan</h2>
        <div className="flex items-center gap-3">
          <select value={plan} onChange={(e) => setPlan(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none">
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Enterprise</option>
          </select>
          <button onClick={savePlan} disabled={saving}
            className="rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50">
            Save Plan
          </button>
        </div>
      </div>

      {/* Quota */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Quota</h2>
        <div className="grid grid-cols-2 gap-4">
          {quotaFields.map(({ key, label }) => (
            <div key={key}>
              <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
              <input type="number" min={0} value={quota[key]}
                onChange={(e) => setQuota({ ...quota, [key]: parseInt(e.target.value, 10) || 0 })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none" />
              {key === 'maxMonthlyTokens' && quota[key] > 0 && (
                <p className="text-xs text-slate-400 mt-1">Current value: {quota[key].toLocaleString()}</p>
              )}
            </div>
          ))}
        </div>
        <button onClick={saveQuota} disabled={saving}
          className="mt-4 rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50">
          Save Quota
        </button>
      </div>
    </div>
  );
}
