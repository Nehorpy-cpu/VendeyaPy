'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signInWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth';
import { firebaseAuth } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { isValidEmail, resetOutcome } from '@/lib/password-reset';
import { Logo } from '@/components/marketing/ui';
import { MetricCard } from '@/components/marketing/MetricCard';
import { AnimatedChart } from '@/components/marketing/AnimatedChart';
import {
  ArrowRightIcon,
  TrendingIcon,
  BagIcon,
  CheckIcon,
  ChatIcon,
  ShieldIcon,
} from '@/components/marketing/icons';

export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Recuperación de contraseña (PASSWORD-RESET-UX).
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState<string | null>(null);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  // Si ya está logueado, ir al panel.
  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [loading, user, router]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(firebaseAuth(), email.trim(), password);
      router.replace('/dashboard');
    } catch {
      setError('Email o contraseña incorrectos.');
    } finally {
      setSubmitting(false);
    }
  };

  const openReset = () => {
    setError(null);
    setResetError(null);
    setResetSent(null);
    setMode('reset');
  };
  const backToLogin = () => {
    setMode('login');
    setResetError(null);
    setResetSent(null);
  };

  const onReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError(null);
    setResetSent(null);
    if (!isValidEmail(email)) {
      setResetError('Ingresá un email válido.');
      return;
    }
    setResetSubmitting(true);
    try {
      await sendPasswordResetEmail(firebaseAuth(), email.trim());
      setResetSent(resetOutcome('').msg); // mensaje genérico (no revela existencia)
    } catch (err) {
      const code = (err as { code?: string })?.code ?? '';
      const outcome = resetOutcome(code);
      // user-not-found → se trata como éxito (no revelar); el resto muestra error amigable.
      if (outcome.kind === 'success') setResetSent(outcome.msg);
      else setResetError(outcome.msg);
    } finally {
      setResetSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen bg-white">
      {/* Panel visual (solo desktop) */}
      <aside className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-ink-deep p-12 lg:flex xl:w-[55%]">
        <div className="bg-grid-dark absolute inset-0 opacity-50" aria-hidden />
        <div
          className="absolute -right-20 top-1/3 h-72 w-72 rounded-full bg-mint-brand opacity-20 blur-3xl"
          aria-hidden
        />

        <div className="relative">
          <Logo tone="light" />
        </div>

        <div className="relative flex flex-col gap-7">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-mint-200 ring-1 ring-inset ring-white/15">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              Panel comercial
            </span>
            <h1 className="mt-5 max-w-md text-balance text-3xl font-bold leading-tight tracking-tight text-white">
              Convertí conversaciones en{' '}
              <span className="text-gradient">ganancia medible</span>
            </h1>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-200">
              Catálogo, bot, vendedores, pedidos y campañas en un solo lugar. Entrá y mirá qué canal
              vende y qué deja ganancia real.
            </p>
          </div>

          {/* Mini-snapshot de producto */}
          <div className="glass-dark max-w-md rounded-2xl border border-white/10 p-4">
            <div className="grid grid-cols-2 gap-3">
              <MetricCard
                tone="dark"
                label="ROAS"
                value="4.7x"
                delta="+18%"
                icon={<TrendingIcon className="h-4 w-4" />}
              />
              <MetricCard
                tone="dark"
                label="Ganancia"
                value="₲ 3.6M"
                delta="+9%"
                icon={<BagIcon className="h-4 w-4" />}
              />
            </div>
            <div className="mt-3 h-20">
              <AnimatedChart
                id="login"
                tone="dark"
                data={[12, 16, 14, 22, 20, 28, 26, 34]}
                labels={['L', 'M', 'M', 'J', 'V', 'S', 'D', 'L']}
              />
            </div>
          </div>

          <ul className="flex flex-col gap-2.5 text-sm text-ink-100">
            {[
              { icon: <ChatIcon className="h-4 w-4" />, text: 'Vendé por WhatsApp en un solo flujo' },
              { icon: <TrendingIcon className="h-4 w-4" />, text: 'Atribución de anuncio a ganancia real' },
              { icon: <ShieldIcon className="h-4 w-4" />, text: 'Multiempresa y permisos por rol' },
            ].map((f) => (
              <li key={f.text} className="flex items-center gap-2.5">
                <span className="grid h-6 w-6 place-items-center rounded-lg bg-mint-400/15 text-mint-300">
                  {f.icon}
                </span>
                {f.text}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative text-xs text-ink-300">
          © {new Date().getFullYear()} VendeYaPy · Vendé más. Gestioná mejor. Crecé hoy.
        </div>
      </aside>

      {/* Panel de formulario */}
      <section className="flex w-full flex-col px-5 py-8 sm:px-8 lg:w-1/2 xl:w-[45%]">
        <div className="flex items-center justify-between">
          <div className="lg:hidden">
            <Logo />
          </div>
          <Link
            href="/"
            className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-ink-500 transition-colors hover:text-ink-800"
          >
            <ArrowRightIcon className="h-4 w-4 rotate-180" />
            Volver al inicio
          </Link>
        </div>

        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">
            {mode === 'login' ? (
              <>
                <div className="mb-8">
                  <h2 className="text-2xl font-bold tracking-tight text-ink-900">Entrá a tu panel</h2>
                  <p className="mt-1 text-sm text-ink-500">
                    Usá las credenciales de tu empresa para continuar.
                  </p>
                </div>

                <form onSubmit={onSubmit} className="space-y-4">
                  <div>
                    <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-ink-700">
                      Email
                    </label>
                    <input
                      id="email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-xl border border-ink-200 bg-white px-3.5 py-2.5 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-mint-500 focus:ring-2 focus:ring-mint-500/30"
                      placeholder="tu@email.com"
                    />
                  </div>
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <label htmlFor="password" className="block text-sm font-medium text-ink-700">
                        Contraseña
                      </label>
                      <button
                        type="button"
                        onClick={openReset}
                        className="text-xs font-medium text-mint-700 transition-colors hover:text-mint-800"
                      >
                        ¿Olvidaste tu contraseña?
                      </button>
                    </div>
                    <input
                      id="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full rounded-xl border border-ink-200 bg-white px-3.5 py-2.5 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-mint-500 focus:ring-2 focus:ring-mint-500/30"
                      placeholder="••••••••"
                    />
                  </div>

                  {error && (
                    <p className="flex items-center gap-2 rounded-xl bg-coral-50 px-3.5 py-2.5 text-sm text-coral-700 ring-1 ring-inset ring-coral-100">
                      {error}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="group inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-mint-brand text-sm font-semibold text-white shadow-glow outline-none transition-all duration-200 hover:brightness-[1.05] focus-visible:ring-2 focus-visible:ring-mint-500 focus-visible:ring-offset-2 disabled:opacity-60"
                  >
                    {submitting ? 'Ingresando…' : 'Ingresar'}
                    {!submitting && (
                      <ArrowRightIcon className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                    )}
                  </button>
                </form>

                <p className="mt-5 text-center text-sm text-ink-500">
                  ¿No tenés cuenta?{' '}
                  <Link href="/register" className="font-semibold text-mint-700 transition-colors hover:text-mint-800">
                    Creá tu empresa
                  </Link>
                </p>

                {process.env['NEXT_PUBLIC_USE_EMULATORS'] === 'true' && (
                  <div className="mt-6 rounded-xl border border-ink-100 bg-ink-50/60 p-3.5 text-xs text-ink-500">
                    <p className="mb-1 flex items-center gap-1.5 font-semibold text-ink-600">
                      <CheckIcon className="h-3.5 w-3.5 text-mint-600" />
                      Usuarios de prueba (emulador):
                    </p>
                    <p>superadmin@aiafg.com · owner@perfumeria.com · seller@perfumeria.com</p>
                    <p className="mt-0.5">
                      Contraseña: <span className="font-mono text-ink-700">test1234</span>
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="mb-8">
                  <h2 className="text-2xl font-bold tracking-tight text-ink-900">Recuperar contraseña</h2>
                  <p className="mt-1 text-sm text-ink-500">
                    Ingresá tu email y te enviamos un enlace para crear una nueva contraseña.
                  </p>
                </div>

                {resetSent ? (
                  <div className="space-y-5">
                    <p role="status" className="rounded-xl bg-mint-50 px-3.5 py-2.5 text-sm text-mint-800 ring-1 ring-inset ring-mint-100">
                      {resetSent}
                    </p>
                    <button
                      type="button"
                      onClick={backToLogin}
                      className="inline-flex items-center gap-1.5 text-sm font-semibold text-mint-700 transition-colors hover:text-mint-800"
                    >
                      <ArrowRightIcon className="h-4 w-4 rotate-180" />
                      Volver a iniciar sesión
                    </button>
                  </div>
                ) : (
                  <form onSubmit={onReset} className="space-y-4" noValidate>
                    <div>
                      <label htmlFor="reset-email" className="mb-1.5 block text-sm font-medium text-ink-700">
                        Email
                      </label>
                      <input
                        id="reset-email"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full rounded-xl border border-ink-200 bg-white px-3.5 py-2.5 text-sm text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus:border-mint-500 focus:ring-2 focus:ring-mint-500/30"
                        placeholder="tu@email.com"
                      />
                    </div>

                    {resetError && (
                      <p role="alert" className="flex items-center gap-2 rounded-xl bg-coral-50 px-3.5 py-2.5 text-sm text-coral-700 ring-1 ring-inset ring-coral-100">
                        {resetError}
                      </p>
                    )}

                    <button
                      type="submit"
                      disabled={resetSubmitting}
                      className="group inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-mint-brand text-sm font-semibold text-white shadow-glow outline-none transition-all duration-200 hover:brightness-[1.05] focus-visible:ring-2 focus-visible:ring-mint-500 focus-visible:ring-offset-2 disabled:opacity-60"
                    >
                      {resetSubmitting ? 'Enviando…' : 'Enviarme el enlace'}
                    </button>

                    <button
                      type="button"
                      onClick={backToLogin}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 transition-colors hover:text-ink-800"
                    >
                      <ArrowRightIcon className="h-4 w-4 rotate-180" />
                      Volver a iniciar sesión
                    </button>
                  </form>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
