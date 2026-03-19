import { useState, useEffect } from 'react';
import { user as userApi } from '../lib/api';
import Badge from '../components/Badge';

export default function Settings() {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadProvider(); }, []);

  async function loadProvider() {
    try {
      const config = await userApi.getProvider();
      setHasExistingKey(config.hasApiKey);
      setBaseUrl(config.anthropicBaseUrl || '');
    } catch (err) {
      console.error('Failed to load provider config:', err);
    } finally {
      setLoading(false);
    }
  }

  async function saveProvider() {
    setSaving(true);
    setStatus(null);
    try {
      const data: Record<string, string> = {};
      if (apiKey.trim()) data.anthropicApiKey = apiKey.trim();
      if (baseUrl.trim()) data.anthropicBaseUrl = baseUrl.trim();
      const result = await userApi.updateProvider(data);
      setHasExistingKey(result.hasApiKey);
      setApiKey('');
      setStatus('saved');
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      console.error('Failed to save provider config:', err);
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;

  return (
    <div className="animate-fade-in space-y-8">
      <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Anthropic API Configuration</h2>
        <p className="text-sm text-slate-500 mb-4">
          Configure your Anthropic API credentials to use direct API access instead of Bedrock for individual bots.
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">API Key</label>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasExistingKey ? 'Key configured (enter new to replace)' : 'sk-ant-...'}
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
              {hasExistingKey && (
                <Badge variant="success">Configured</Badge>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Base URL (optional)</label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.anthropic.com"
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
            />
            <p className="text-xs text-slate-400 mt-1">Leave empty to use default Anthropic API endpoint. Set for proxies or compatible APIs.</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={saveProvider}
              disabled={saving || (!apiKey.trim() && !baseUrl.trim())}
              className="rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            {status === 'saved' && <span className="text-sm text-emerald-600">Saved</span>}
            {status === 'error' && <span className="text-sm text-red-600">Failed to save</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
