'use client';

/**
 * /welcome — Onboarding inicial del owner (Fase registro R-3).
 *
 * Gate de entrada al panel: el RegistrationGate manda acá al owner cuyo tenant tiene
 * onboarding.completed === false. Wizard simple (rubro + CTAs) que termina llamando
 * completeOnboarding (callable, Admin SDK — la rule R-2 cierra ese flag a callable-only)
 * y redirige a /dashboard. Si ya está completo, sale solo a /dashboard (sin loop).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { doc, getDoc } from 'firebase/firestore';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth-context';
import { firebaseDb } from '@/lib/firebase';
import { INDUSTRY_TEMPLATES, applyTemplate, type IndustryTemplate } from '@/lib/templates';
import { completeOnboarding, getTenantOnboardingCompleted } from '@/lib/registration';
import { Logo } from '@/components/marketing/ui';

export default function WelcomePage() {
  const router = useRouter();
  const { user, claims, loading } = useAuth();
  const tenantId = claims.tenantId;

  const [businessName, setBusinessName] = useState<string>('');
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // chequeo inicial hecho (auth + onboarding flag)

  // Guard de entrada: sin sesión → login; ya completado → dashboard; si no, mostrar wizard.
  useEffect(() => {
    let cancelled = false;
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!tenantId) {
      // Claims aún no propagaron tras el alta; el gate del panel maneja el "preparando".
      return;
    }
    (async () => {
      const done = await getTenantOnboardingCompleted(tenantId);
      if (cancelled) return;
      if (done) {
        router.replace('/dashboard');
        return;
      }
      const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId)).catch(() => null);
      if (cancelled) return;
      setBusinessName((snap?.data()?.['name'] as string | undefined) ?? '');
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, user, tenantId, router]);

  const applyMut = useMutation({
    mutationFn: (t: IndustryTemplate) => applyTemplate(tenantId!, t),
    onSuccess: (_d, t) => setAppliedId(t.id),
  });

  const finishMut = useMutation({
    mutationFn: () => completeOnboarding(tenantId ?? undefined),
    onSuccess: () => router.replace('/dashboard'),
  });

  if (loading || !ready) {
    return <main className="flex min-h-screen items-center justify-center text-ink-400">Cargando…</main>;
  }

  return (
    <main className="min-h-screen bg-ink-50/40">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Logo />
        <button
          onClick={() => finishMut.mutate()}
          disabled={finishMut.isPending}
          className="text-sm font-medium text-ink-500 transition-colors hover:text-ink-800 disabled:opacity-60"
        >
          Saltar por ahora
        </button>
      </header>

      <section className="mx-auto w-full max-w-3xl px-5 py-6 sm:py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
            ¡Bienvenido/a{businessName ? ` a ${businessName}` : ''}! 🎉
          </h1>
          <p className="mt-1 text-sm text-ink-500">Dejemos tu negocio listo para vender. Elegí tu rubro y entrá al panel.</p>
        </div>

        {/* Paso 1: rubro */}
        <div className="mb-8">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-500">1 · Elegí tu rubro</h2>
          <p className="mb-3 text-xs text-ink-500">
            Aplicar una plantilla precarga el nombre y tono del agente, su saludo, reglas de venta y categorías típicas.
            Podés ajustar todo después.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {INDUSTRY_TEMPLATES.map((t) => {
              const active = appliedId === t.id;
              const pending = applyMut.isPending && applyMut.variables?.id === t.id;
              return (
                <div key={t.id} className={'rounded-xl border bg-white p-4 ' + (active ? 'border-mint-500 ring-1 ring-mint-200' : 'border-ink-200')}>
                  <div className="text-3xl">{t.emoji}</div>
                  <div className="mt-1 font-semibold text-ink-900">{t.rubro}</div>
                  <div className="mt-1 text-xs text-ink-500">Agente “{t.agent.agentName}” · {t.categories.length} categorías</div>
                  <button
                    onClick={() => applyMut.mutate(t)}
                    disabled={applyMut.isPending}
                    className={'mt-3 w-full rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-60 ' + (active ? 'border border-mint-500 text-mint-700 hover:bg-mint-50' : 'bg-mint-brand text-white hover:brightness-105')}
                  >
                    {pending ? 'Aplicando…' : active ? '✓ Aplicada' : 'Aplicar plantilla'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Paso 2: próximos pasos (CTAs) */}
        <div className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">2 · Próximos pasos</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Link href="/billing" className="group rounded-xl border border-ink-200 bg-white p-4 transition hover:border-mint-400 hover:shadow-sm">
              <div className="text-2xl">💬</div>
              <div className="mt-1 font-semibold text-ink-900">Activá tu plan por WhatsApp</div>
              <p className="mt-1 text-xs text-ink-500">Pedí tu plan y activámoslo manualmente. Arrancás en el plan gratis.</p>
            </Link>
            <Link href="/integrations" className="group rounded-xl border border-ink-200 bg-white p-4 transition hover:border-mint-400 hover:shadow-sm">
              <div className="text-2xl">📲</div>
              <div className="mt-1 font-semibold text-ink-900">Conectá tu cuenta de Meta</div>
              <p className="mt-1 text-xs text-ink-500">Sumá Meta más adelante para medir y atribuir tus anuncios. La mensajería por Instagram y Messenger llega próximamente.</p>
            </Link>
          </div>
        </div>

        {finishMut.isError && (
          <p className="mb-3 rounded-xl bg-coral-50 px-3.5 py-2.5 text-sm text-coral-700 ring-1 ring-inset ring-coral-100">
            No pudimos finalizar el onboarding. Probá de nuevo.
          </p>
        )}

        <button
          onClick={() => finishMut.mutate()}
          disabled={finishMut.isPending}
          className="inline-flex h-12 w-full items-center justify-center rounded-full bg-mint-brand text-sm font-semibold text-white shadow-glow transition hover:brightness-105 disabled:opacity-60 sm:w-auto sm:px-8"
        >
          {finishMut.isPending ? 'Entrando…' : 'Ir al panel →'}
        </button>
      </section>
    </main>
  );
}
