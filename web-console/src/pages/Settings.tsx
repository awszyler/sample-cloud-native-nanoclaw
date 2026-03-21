import { useState, useEffect } from 'react';
import {
  user as userApi,
  admin as adminApi,
  proxyRules as proxyRulesApi,
  type ProviderFull,
  type CreateProviderRequest,
  type ProxyRuleSummary,
  type ProxyRuleInput,
} from '../lib/api';
import Badge from '../components/Badge';
import { Plus, Trash2, Edit2, Shield, Server, Star, X } from 'lucide-react';

type Tab = 'providers' | 'credentials';

// ── Model Presets ─────────────────────────────────────────────────────────

const BEDROCK_PRESETS = [
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-4-6-v1',
];
const ANTHROPIC_PRESETS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
];

// ── Providers Tab (Admin only) ────────────────────────────────────────────

interface ProviderForm {
  providerName: string;
  providerType: 'bedrock' | 'anthropic-compatible-api';
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  isDefault: boolean;
}

const EMPTY_FORM: ProviderForm = {
  providerName: '',
  providerType: 'bedrock',
  baseUrl: '',
  apiKey: '',
  modelIds: [],
  isDefault: false,
};

function ProvidersTab() {
  const [providers, setProviders] = useState<ProviderFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null); // null, 'new', or providerId
  const [form, setForm] = useState<ProviderForm>({ ...EMPTY_FORM });
  const [customModel, setCustomModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { loadProviders(); }, []);

  async function loadProviders() {
    try {
      const data = await adminApi.listProviders();
      setProviders(data);
    } catch (err) {
      console.error('Failed to load providers:', err);
    } finally {
      setLoading(false);
    }
  }

  function startNew() {
    setEditing('new');
    setForm({ ...EMPTY_FORM });
    setCustomModel('');
    setError('');
  }

  function startEdit(provider: ProviderFull) {
    setEditing(provider.providerId);
    setForm({
      providerName: provider.providerName,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl || '',
      apiKey: '',
      modelIds: [...provider.modelIds],
      isDefault: provider.isDefault,
    });
    setCustomModel('');
    setError('');
  }

  function cancel() {
    setEditing(null);
    setError('');
  }

  function toggleModel(modelId: string) {
    setForm((f) => ({
      ...f,
      modelIds: f.modelIds.includes(modelId)
        ? f.modelIds.filter((m) => m !== modelId)
        : [...f.modelIds, modelId],
    }));
  }

  function addCustomModel() {
    const trimmed = customModel.trim();
    if (!trimmed || form.modelIds.includes(trimmed)) return;
    setForm((f) => ({ ...f, modelIds: [...f.modelIds, trimmed] }));
    setCustomModel('');
  }

  function removeModel(modelId: string) {
    setForm((f) => ({ ...f, modelIds: f.modelIds.filter((m) => m !== modelId) }));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (editing === 'new') {
        const payload: CreateProviderRequest = {
          providerName: form.providerName,
          providerType: form.providerType,
          modelIds: form.modelIds,
          isDefault: form.isDefault,
        };
        if (form.providerType === 'anthropic-compatible-api') {
          if (form.baseUrl.trim()) payload.baseUrl = form.baseUrl.trim();
          if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        } else {
          // Bedrock: apiKey is optional (for cross-account scenarios)
          if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        }
        await adminApi.createProvider(payload);
      } else {
        const payload: Record<string, unknown> = {
          providerName: form.providerName,
          providerType: form.providerType,
          modelIds: form.modelIds,
          isDefault: form.isDefault,
        };
        if (form.providerType === 'anthropic-compatible-api') {
          payload.baseUrl = form.baseUrl.trim() || null;
          if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        } else {
          if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        }
        await adminApi.updateProvider(editing!, payload);
      }
      setEditing(null);
      await loadProviders();
    } catch (err: any) {
      setError(err.message || 'Failed to save provider');
    } finally {
      setSaving(false);
    }
  }

  async function remove(providerId: string) {
    if (!confirm('Delete this model provider? Bots using it will fall back to the default provider.')) return;
    try {
      await adminApi.deleteProvider(providerId);
      await loadProviders();
    } catch (err) {
      console.error('Failed to delete provider:', err);
    }
  }

  const presets = form.providerType === 'bedrock' ? BEDROCK_PRESETS : ANTHROPIC_PRESETS;

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">Model Providers</h2>
          {!editing && (
            <button onClick={startNew} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-3 py-2 text-sm font-medium hover:bg-accent-600">
              <Plus size={16} /> Add Provider
            </button>
          )}
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Manage AI model providers available to bots. Configure Bedrock or Anthropic-compatible API endpoints.
        </p>

        {providers.length > 0 && (
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium">Type</th>
                <th className="py-2 font-medium">Models</th>
                <th className="py-2 font-medium">Default</th>
                <th className="py-2 font-medium">API Key</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.providerId} className="border-b border-slate-100">
                  <td className="py-2.5 font-medium text-slate-900">{p.providerName}</td>
                  <td className="py-2.5">
                    <Badge variant={p.providerType === 'bedrock' ? 'info' : 'neutral'}>
                      {p.providerType === 'bedrock' ? 'Bedrock' : 'Anthropic API'}
                    </Badge>
                  </td>
                  <td className="py-2.5 text-slate-600">{p.modelIds.length} model{p.modelIds.length !== 1 ? 's' : ''}</td>
                  <td className="py-2.5">
                    {p.isDefault && (
                      <span className="inline-flex items-center gap-1 text-amber-600">
                        <Star size={14} className="fill-amber-400" /> Default
                      </span>
                    )}
                  </td>
                  <td className="py-2.5">
                    {p.hasApiKey ? (
                      <Badge variant="success">Configured</Badge>
                    ) : p.providerType === 'bedrock' ? (
                      <Badge variant="neutral">None</Badge>
                    ) : (
                      <Badge variant="error">Missing</Badge>
                    )}
                  </td>
                  <td className="py-2.5 text-right">
                    <button onClick={() => startEdit(p)} className="text-slate-400 hover:text-accent-600 p-1"><Edit2 size={15} /></button>
                    <button onClick={() => remove(p.providerId)} className="text-slate-400 hover:text-red-600 p-1 ml-1"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {providers.length === 0 && !editing && (
          <div className="text-center py-8 text-slate-400">
            No providers configured. Add one to get started.
          </div>
        )}
      </div>

      {/* Provider Form */}
      {editing && (
        <div className="bg-white rounded-xl shadow-sm border border-accent-200 p-6">
          <h3 className="text-md font-semibold text-slate-900 mb-4">
            {editing === 'new' ? 'Add Provider' : 'Edit Provider'}
          </h3>
          {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            {/* Provider Name */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Provider Name</label>
              <input
                value={form.providerName}
                onChange={(e) => setForm((f) => ({ ...f, providerName: e.target.value }))}
                placeholder="e.g. Production Bedrock"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>

            {/* Provider Type */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Provider Type</label>
              <select
                value={form.providerType}
                onChange={(e) => {
                  const newType = e.target.value as ProviderForm['providerType'];
                  setForm((f) => ({ ...f, providerType: newType, modelIds: [], baseUrl: '', apiKey: '' }));
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              >
                <option value="bedrock">Bedrock</option>
                <option value="anthropic-compatible-api">Anthropic Compatible API</option>
              </select>
            </div>

            {/* Base URL (anthropic-compatible-api only) */}
            {form.providerType === 'anthropic-compatible-api' && (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Base URL (optional)</label>
                <input
                  type="url"
                  value={form.baseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  placeholder="https://api.anthropic.com"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
                />
                <p className="text-xs text-slate-400 mt-1">Leave empty to use default Anthropic API endpoint.</p>
              </div>
            )}

            {/* API Key */}
            {(form.providerType === 'anthropic-compatible-api' || form.providerType === 'bedrock') && (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  API Key {form.providerType === 'bedrock' && <span className="text-slate-400 font-normal">(optional)</span>}
                  {editing !== 'new' && <span className="text-slate-400 font-normal"> — leave empty to keep current</span>}
                </label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  placeholder={editing !== 'new' ? 'Leave empty to keep current' : form.providerType === 'bedrock' ? 'Optional — uses IAM role by default' : 'sk-ant-...'}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
                />
              </div>
            )}

            {/* Model IDs Section */}
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-2">Model IDs</label>

              {/* Preset checkboxes */}
              <div className="space-y-2 mb-3">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Presets</p>
                <div className="flex flex-wrap gap-3">
                  {presets.map((modelId) => (
                    <label key={modelId} className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.modelIds.includes(modelId)}
                        onChange={() => toggleModel(modelId)}
                        className="rounded border-slate-300 text-accent-500 focus:ring-accent-500/20"
                      />
                      <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{modelId}</code>
                    </label>
                  ))}
                </div>
              </div>

              {/* Custom model input */}
              <div className="flex items-center gap-2 mb-3">
                <input
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomModel(); } }}
                  placeholder="Add custom model ID"
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
                />
                <button
                  onClick={addCustomModel}
                  disabled={!customModel.trim()}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus size={14} /> Add
                </button>
              </div>

              {/* Selected models as removable chips */}
              {form.modelIds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {form.modelIds.map((modelId) => (
                    <span
                      key={modelId}
                      className="inline-flex items-center gap-1 rounded-full bg-accent-50 text-accent-700 px-2.5 py-1 text-xs font-medium ring-1 ring-inset ring-accent-600/20"
                    >
                      {modelId}
                      <button onClick={() => removeModel(modelId)} className="hover:text-red-600 ml-0.5">
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {form.modelIds.length === 0 && (
                <p className="text-xs text-slate-400">No models selected. Select presets above or add custom model IDs.</p>
              )}
            </div>

            {/* Set as default */}
            <div className="col-span-2">
              <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
                  className="rounded border-slate-300 text-accent-500 focus:ring-accent-500/20"
                />
                <span className="flex items-center gap-1">
                  <Star size={14} className="text-amber-500" /> Set as default provider
                </span>
              </label>
              <p className="text-xs text-slate-400 mt-1 ml-6">New bots will use this provider unless overridden.</p>
            </div>
          </div>

          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={save}
              disabled={saving || !form.providerName.trim() || form.modelIds.length === 0}
              className="rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save Provider'}
            </button>
            <button onClick={cancel} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── API Credentials Tab ───────────────────────────────────────────────────

const AUTH_TYPE_LABELS: Record<string, string> = {
  'bearer': 'Bearer Token',
  'api-key': 'API Key Header',
  'basic': 'Basic Auth',
};

const PRESETS: Array<Omit<ProxyRuleInput, 'value'> & { description: string }> = [
  { name: 'Anthropic', prefix: '/anthropic', target: 'https://api.anthropic.com', authType: 'api-key', headerName: 'x-api-key', description: 'Claude API (direct key)' },
  { name: 'OpenAI', prefix: '/openai', target: 'https://api.openai.com', authType: 'bearer', description: 'GPT / DALL-E / Whisper' },
  { name: 'GitHub', prefix: '/github', target: 'https://api.github.com', authType: 'bearer', description: 'Repos, issues, PRs' },
  { name: 'Jira', prefix: '/jira', target: 'https://your-domain.atlassian.net', authType: 'basic', description: 'Atlassian Jira (user:token)' },
  { name: 'Google AI', prefix: '/google-ai', target: 'https://generativelanguage.googleapis.com', authType: 'api-key', headerName: 'x-goog-api-key', description: 'Gemini API' },
];

function CredentialsTab() {
  const [rules, setRules] = useState<ProxyRuleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ProxyRuleInput>({ name: '', prefix: '', target: '', authType: 'bearer', value: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { loadRules(); }, []);

  async function loadRules() {
    try {
      const data = await proxyRulesApi.list();
      setRules(data);
    } catch (err) {
      console.error('Failed to load proxy rules:', err);
    } finally {
      setLoading(false);
    }
  }

  function startNew() {
    setEditing('new');
    setForm({ name: '', prefix: '/', target: 'https://', authType: 'bearer', value: '' });
    setError('');
  }

  function startFromPreset(preset: typeof PRESETS[number]) {
    setEditing('new');
    setForm({ name: preset.name, prefix: preset.prefix, target: preset.target, authType: preset.authType, headerName: preset.headerName, value: '' });
    setError('');
  }

  function startEdit(rule: ProxyRuleSummary) {
    setEditing(rule.id);
    setForm({ name: rule.name, prefix: rule.prefix, target: rule.target, authType: rule.authType, headerName: rule.headerName, value: '' });
    setError('');
  }

  function cancel() {
    setEditing(null);
    setError('');
  }

  function handleNameChange(name: string) {
    const prefix = '/' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    setForm((f) => ({ ...f, name, prefix }));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (editing === 'new') {
        await proxyRulesApi.create(form);
      } else {
        // Strip empty value to preserve existing secret
        const payload = { ...form };
        if (!payload.value) delete (payload as Partial<ProxyRuleInput>).value;
        await proxyRulesApi.update(editing!, payload);
      }
      setEditing(null);
      await loadRules();
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this credential rule?')) return;
    try {
      await proxyRulesApi.remove(id);
      await loadRules();
    } catch (err) {
      console.error('Failed to delete rule:', err);
    }
  }

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">API Credential Proxy Rules</h2>
          {!editing && (
            <button onClick={startNew} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-3 py-2 text-sm font-medium hover:bg-accent-600">
              <Plus size={16} /> Add Rule
            </button>
          )}
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Configure credentials injected into agent API calls. Keys are never exposed to the agent — they are injected by a secure local proxy.
        </p>

        {rules.length > 0 && (
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium">Target</th>
                <th className="py-2 font-medium">Auth Type</th>
                <th className="py-2 font-medium">Prefix</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-slate-100">
                  <td className="py-2.5 font-medium text-slate-900">{rule.name}</td>
                  <td className="py-2.5 text-slate-600 truncate max-w-[200px]">{rule.target}</td>
                  <td className="py-2.5 text-slate-600">{AUTH_TYPE_LABELS[rule.authType]}</td>
                  <td className="py-2.5"><code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{rule.prefix}</code></td>
                  <td className="py-2.5">{rule.hasValue ? <Badge variant="success">Configured</Badge> : <Badge variant="warning">No Key</Badge>}</td>
                  <td className="py-2.5 text-right">
                    <button onClick={() => startEdit(rule)} className="text-slate-400 hover:text-accent-600 p-1"><Edit2 size={15} /></button>
                    <button onClick={() => remove(rule.id)} className="text-slate-400 hover:text-red-600 p-1 ml-1"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rules.length === 0 && !editing && (
          <div className="text-center py-8 text-slate-400">
            No credential rules configured. Use a preset below or add a custom rule.
          </div>
        )}

        {/* Presets — show available templates (hide already-configured ones) */}
        {!editing && (() => {
          const existingPrefixes = new Set(rules.map((r) => r.prefix));
          const available = PRESETS.filter((p) => !existingPrefixes.has(p.prefix));
          if (available.length === 0) return null;
          return (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">Quick Add</p>
              <div className="flex flex-wrap gap-2">
                {available.map((preset) => (
                  <button
                    key={preset.prefix}
                    onClick={() => startFromPreset(preset)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-700 hover:bg-accent-50 hover:border-accent-200 hover:text-accent-700 transition-colors"
                  >
                    <Plus size={14} /> {preset.name} <span className="text-slate-400">— {preset.description}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      {editing && (
        <div className="bg-white rounded-xl shadow-sm border border-accent-200 p-6">
          <h3 className="text-md font-semibold text-slate-900 mb-4">{editing === 'new' ? 'Add Rule' : 'Edit Rule'}</h3>
          {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
              <input
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. GitHub"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Path Prefix</label>
              <input
                value={form.prefix}
                onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value }))}
                placeholder="/github"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-mono focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Target URL</label>
              <input
                value={form.target}
                onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
                placeholder="https://api.github.com"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Auth Type</label>
              <select
                value={form.authType}
                onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value as ProxyRuleInput['authType'] }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              >
                <option value="bearer">Bearer Token</option>
                <option value="api-key">API Key Header</option>
                <option value="basic">Basic Auth</option>
              </select>
            </div>
            {form.authType === 'api-key' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Header Name</label>
                <input
                  value={form.headerName || ''}
                  onChange={(e) => setForm((f) => ({ ...f, headerName: e.target.value }))}
                  placeholder="x-api-key"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
                />
              </div>
            )}
            <div className={form.authType === 'api-key' ? 'col-span-2' : ''}>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Secret {editing !== 'new' && <span className="text-slate-400 font-normal">(leave empty to keep current)</span>}
              </label>
              <input
                type="password"
                value={form.value}
                onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                placeholder={editing !== 'new' ? 'Enter new value to replace' : 'Enter secret value'}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={save}
              disabled={saving || !form.name || !form.target || (editing === 'new' && !form.value)}
              className="rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save Rule'}
            </button>
            <button onClick={cancel} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────

export default function Settings() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [tab, setTab] = useState<Tab>('credentials');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    userApi.me().then((me) => {
      setIsAdmin(!!me.isAdmin);
      setTab(me.isAdmin ? 'providers' : 'credentials');
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <div className="text-center py-12 text-slate-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>

      <div className="flex gap-1 border-b border-slate-200">
        {isAdmin && (
          <button
            onClick={() => setTab('providers')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === 'providers'
                ? 'border-accent-500 text-accent-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Server size={16} /> Model Providers
          </button>
        )}
        <button
          onClick={() => setTab('credentials')}
          className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === 'credentials'
              ? 'border-accent-500 text-accent-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Shield size={16} /> API Credentials
        </button>
      </div>

      {tab === 'providers' && isAdmin && <ProvidersTab />}
      {tab === 'credentials' && <CredentialsTab />}
    </div>
  );
}
