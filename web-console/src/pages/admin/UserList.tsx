import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { admin, AdminUser } from '../../lib/api';
import Badge from '../../components/Badge';

export default function UserList() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    admin.listUsers()
      .then(setUsers)
      .catch((err) => console.error('Failed to load users:', err))
      .finally(() => setLoading(false));
  }, []);

  function formatDate(dateStr?: string): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
  }

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;

  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">Admin — Users</h1>
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Email</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Plan</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Tokens (used / max)</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Bots</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Last Login</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-slate-200">
            {users.map((u) => (
              <tr key={u.userId} className="hover:bg-slate-50 transition-colors">
                <td className="px-6 py-4 whitespace-nowrap">
                  <Link to={`/admin/users/${u.userId}`} className="text-accent-600 hover:text-accent-500 font-medium">
                    {u.email || u.userId}
                  </Link>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <Badge variant={
                    u.plan === 'enterprise' ? 'info' :
                    u.plan === 'pro' ? 'success' :
                    'neutral'
                  }>{u.plan}</Badge>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700">
                  {u.usageTokens.toLocaleString()} / {u.quota?.maxMonthlyTokens?.toLocaleString() ?? '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700">
                  {(u.botCount ?? 0).toLocaleString()} / {u.quota?.maxBots?.toLocaleString() ?? '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                  {formatDate(u.lastLogin)}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-slate-500">No users found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
