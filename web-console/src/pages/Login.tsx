import { useState } from 'react';
import { useAuth } from '../lib/auth';

export default function Login() {
  const { login, register, needsNewPassword, completeNewPassword } = useAuth();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState(() => localStorage.getItem('clawbot_saved_email') || '');
  const [password, setPassword] = useState(() => localStorage.getItem('clawbot_saved_pass') || '');
  const [rememberMe, setRememberMe] = useState(() => !!localStorage.getItem('clawbot_saved_email'));
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isRegister) {
        await register(email, password);
        setError('Check your email for verification code, then sign in.');
        setIsRegister(false);
      } else {
        if (rememberMe) {
          localStorage.setItem('clawbot_saved_email', email);
          localStorage.setItem('clawbot_saved_pass', password);
        } else {
          localStorage.removeItem('clawbot_saved_email');
          localStorage.removeItem('clawbot_saved_pass');
        }
        await login(email, password);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await completeNewPassword(newPassword);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const inputClasses =
    'w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none';

  const buttonClasses =
    'w-full rounded-lg bg-accent-500 text-white py-2.5 text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50';

  /* ---------- Left branding panel (shared by all states) ---------- */
  const leftPanel = (
    <div className="hidden lg:flex lg:w-[40%] bg-sidebar-900 relative overflow-hidden flex-col items-center justify-center px-12">
      {/* Decorative gradient circles */}
      <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-accent-500/10 blur-3xl" />
      <div className="absolute -bottom-24 -right-24 h-72 w-72 rounded-full bg-accent-400/10 blur-3xl" />

      <div className="relative z-10 text-center">
        <span className="text-5xl" role="img" aria-label="lobster">🦞</span>
        <h1 className="mt-6 text-3xl font-bold text-white">NanoClaw on Cloud</h1>
        <p className="mt-3 text-slate-400 text-sm leading-relaxed">
          Multi-tenant AI assistant platform on AWS
        </p>
      </div>
    </div>
  );

  /* ---------- Force-new-password screen ---------- */
  if (needsNewPassword) {
    return (
      <div className="flex min-h-screen">
        {leftPanel}

        <div className="flex flex-1 items-center justify-center bg-white px-6">
          <div className="w-full max-w-md space-y-8">
            {/* Mobile-only branding */}
            <div className="text-center lg:hidden">
              <span className="text-4xl" role="img" aria-label="lobster">🦞</span>
            </div>

            <div>
              <h2 className="text-center text-2xl font-bold text-slate-900">Set new password</h2>
              <p className="mt-2 text-center text-sm text-slate-500">
                Your account requires a new password before continuing.
              </p>
            </div>

            <form onSubmit={handleNewPassword} className="space-y-6">
              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">New Password</label>
                <input
                  type="password"
                  required
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  className={inputClasses}
                />
              </div>

              <button type="submit" disabled={loading} className={buttonClasses}>
                {loading ? 'Loading...' : 'Set Password'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- Sign-in / Register screen ---------- */
  return (
    <div className="flex min-h-screen">
      {leftPanel}

      <div className="flex flex-1 items-center justify-center bg-white px-6">
        <div className="w-full max-w-md space-y-8">
          {/* Mobile-only branding */}
          <div className="text-center lg:hidden">
            <span className="text-4xl" role="img" aria-label="lobster">🦞</span>
          </div>

          <div>
            <h2 className="text-center text-2xl font-bold text-slate-900">
              {isRegister ? 'Create your account' : 'Sign in to your account'}
            </h2>
            <p className="mt-2 text-center text-sm text-slate-500">
              {isRegister
                ? 'Get started with NanoClaw on Cloud'
                : 'Welcome back to NanoClaw on Cloud'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className={inputClasses}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className={inputClasses}
              />
            </div>

            {!isRegister && (
              <div className="flex items-center">
                <input
                  id="remember-me"
                  type="checkbox"
                  checked={rememberMe}
                  onChange={e => setRememberMe(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-accent-500 focus:ring-accent-500"
                />
                <label htmlFor="remember-me" className="ml-2 block text-sm text-slate-600">
                  Remember password
                </label>
              </div>
            )}

            <button type="submit" disabled={loading} className={buttonClasses}>
              {loading ? 'Loading...' : (isRegister ? 'Register' : 'Sign in')}
            </button>

            <p className="text-center text-sm text-slate-500">
              {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
              <button
                type="button"
                onClick={() => setIsRegister(!isRegister)}
                className="text-accent-600 hover:text-accent-500 font-medium"
              >
                {isRegister ? 'Sign in' : 'Register'}
              </button>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
