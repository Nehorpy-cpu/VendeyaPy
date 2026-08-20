'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveCompany } from '@/lib/active-company';
import { INDUSTRY_TEMPLATES, applyTemplate, type IndustryTemplate } from '@/lib/templates';
import { getAgentConfig, getCheckoutConfig } from '@/lib/agent-config';
import { listProducts } from '@/lib/catalog';
import { listCustomers } from '@/lib/conversations';
import { friendlyJobError } from '@/lib/entitlements';
import { SectionHeader, EmptyState } from '@/components/ui';
import { EstadoDeAccion } from '@/components/ui/EstadoDeAccion';
import { avisoDeLectura } from '@/lib/lectura';

export default function OnboardingPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();

  const agentQ = useQuery({ queryKey: ['agentConfig', tenantId], queryFn: () => getAgentConfig(tenantId!), enabled: !!tenantId });
  const productsQ = useQuery({ queryKey: ['products', tenantId], queryFn: () => listProducts(tenantId!), enabled: !!tenantId });
  const checkoutQ = useQuery({ queryKey: ['checkoutConfig', tenantId], queryFn: () => getCheckoutConfig(tenantId!), enabled: !!tenantId });
  const customersQ = useQuery({ queryKey: ['customers', tenantId], queryFn: () => listCustomers(tenantId!), enabled: !!tenantId });

  /** H-39: motivo del fallo, visible en pantalla. */
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  // Cambiar de empresa no remonta la pantalla: sin esto el aviso anterior queda colgado.
  useEffect(() => { setErrorAccion(null); }, [tenantId]);

  const applyMut = useMutation({
    mutationFn: (t: IndustryTemplate) => applyTemplate(tenantId!, t),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agentConfig', tenantId] });
      qc.invalidateQueries({ queryKey: ['categories', tenantId] });
      setErrorAccion(null);
    },
    // H-39: si falla, el botón volvía a su estado y no pasaba nada.
    onError: (e) => setErrorAccion(friendlyJobError(e)),
  });

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para configurar sus primeros pasos." />;

  const industry = agentQ.data?.industry ?? '';
  const banks = checkoutQ.data?.bankAccounts ?? [];
  const banksOk = banks.length > 0 && !/REEMPLAZAR/i.test(banks[0]?.bank + ' ' + banks[0]?.accountNumber);
  const steps = [
    { label: 'Elegí tu rubro', done: !!industry, sinLeer: !agentQ.data && !agentQ.isLoading, href: '#rubro', hint: 'Aplicá una plantilla acá abajo.' },
    { label: 'Cargá tus productos', done: (productsQ.data?.length ?? 0) > 0, sinLeer: !productsQ.data && !productsQ.isLoading, href: '/catalog', hint: 'Sumá tu catálogo.' },
    { label: 'Poné tus datos bancarios', done: banksOk, sinLeer: !checkoutQ.data && !checkoutQ.isLoading, href: '/agent', hint: 'Para que el bot pase los datos de pago.' },
    { label: 'Probá tu bot', done: (customersQ.data?.length ?? 0) > 0, sinLeer: !customersQ.data && !customersQ.isLoading, href: '/agent', hint: 'Usá el chat de prueba en Config. del agente.' },
  ];
  // H-15: un paso cuya lectura falló NO está pendiente — no se sabe. Contarlo como no hecho es
  // afirmar sobre algo que nunca se leyó, así que sale del progreso en vez de bajarlo.
  const verificables = steps.filter((s) => !s.sinLeer);
  const avisoProgreso =
    avisoDeLectura(agentQ, 'tu rubro') ??
    avisoDeLectura(productsQ, 'tus productos') ??
    avisoDeLectura(checkoutQ, 'tus datos de cobro') ??
    avisoDeLectura(customersQ, 'tus conversaciones');
  const doneCount = verificables.filter((s) => s.done).length;
  const pct = verificables.length > 0 ? Math.round((doneCount / verificables.length) * 100) : 0;

  return (
    <div className="space-y-6">
      <SectionHeader title="Primeros pasos 🚀" subtitle="Dejá tu negocio listo para vender en unos minutos." />

      {/* H-39: el resultado de aplicar la plantilla, dicho en pantalla. */}
      <EstadoDeAccion tipo="error" mensaje={errorAccion} />

      {/* H-15: el checklist se arma con `data ?? []`; si una lectura falla, los pasos aparecen
          como pendientes y el porcentaje miente sobre lo que el dueño ya configuró. */}
      <EstadoDeAccion tipo="error" mensaje={avisoProgreso} />

      {/* Progreso + checklist */}
      <div className="rounded-2xl border border-ink-100 bg-white p-5 shadow-soft">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-ink-700">Tu progreso</span>
          <span className="text-sm text-ink-500">{verificables.length > 0 ? `${doneCount}/${verificables.length}` : '—'}</span>
        </div>
        {verificables.length > 0 && verificables.length < steps.length ? (
          // Con pasos sin verificar, una barra llena afirmaría «terminaste» sobre lo que no se leyó.
          <p className="mb-4 text-xs text-coral-700">
            No pudimos verificar {steps.length - verificables.length} de {steps.length} pasos, así que no mostramos el progreso.
          </p>
        ) : verificables.length === steps.length ? (
          <div className="mb-4 h-2 w-full rounded-full bg-ink-100">
            <div className="h-2 rounded-full bg-mint-brand transition-all" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        <ul className="space-y-2">
          {steps.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={'flex h-5 w-5 items-center justify-center rounded-full text-xs ' + (s.sinLeer ? 'border border-ink-200 text-ink-400' : s.done ? 'bg-mint-600 text-white' : 'border border-ink-200 text-ink-400')}>{s.sinLeer ? '?' : s.done ? '✓' : ''}</span>
                <div>
                  <div className={'text-sm ' + (!s.sinLeer && s.done ? 'text-ink-400 line-through' : 'text-ink-800')}>{s.label}</div>
                  {s.sinLeer ? <div className="text-xs text-coral-700">No pudimos verificar este paso.</div> : !s.done && <div className="text-xs text-ink-400">{s.hint}</div>}
                </div>
              </div>
              {!s.done && !s.sinLeer && !s.href.startsWith('#') && (
                <Link href={s.href} className="shrink-0 rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-medium text-mint-700 transition-colors hover:bg-ink-50">Ir</Link>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Conectá tu canal real (WhatsApp por Meta) */}
      <Link href="/integrations" className="group flex items-center justify-between gap-3 rounded-2xl border border-mint-200 bg-mint-50/60 p-4 transition-colors hover:bg-mint-50">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-mint-brand text-white shadow-glow">📲</span>
          <div>
            <div className="text-sm font-semibold text-ink-900">Conectá tu WhatsApp con Meta</div>
            <p className="mt-0.5 text-xs text-ink-600">Para que el bot atienda por WhatsApp y puedas medir tus anuncios. La mensajería por Instagram y Messenger llega próximamente.</p>
          </div>
        </div>
        <span className="shrink-0 text-sm font-semibold text-mint-700 group-hover:text-mint-600">Ir →</span>
      </Link>

      {/* Plantillas por rubro */}
      <div id="rubro">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-500">Elegí tu rubro</h2>
        <p className="mb-3 text-xs text-ink-500">Aplicar una plantilla precarga el nombre y tono del agente, su saludo, reglas de venta, preguntas frecuentes y categorías típicas. Después podés ajustar todo.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {INDUSTRY_TEMPLATES.map((t) => {
            const active = industry === t.id;
            return (
              <div key={t.id} className={'rounded-2xl border bg-white p-4 shadow-soft ' + (active ? 'border-mint-500 ring-1 ring-mint-200' : 'border-ink-100')}>
                <div className="text-3xl">{t.emoji}</div>
                <div className="mt-1 font-semibold text-ink-900">{t.rubro}</div>
                <div className="mt-1 text-xs text-ink-500">Agente “{t.agent.agentName}” · {t.categories.length} categorías · {t.agent.faq.length} FAQ</div>
                <button
                  onClick={() => applyMut.mutate(t)}
                  disabled={applyMut.isPending}
                  className={'mt-3 w-full rounded-lg px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-60 ' + (active ? 'border border-mint-500 text-mint-700 hover:bg-mint-50' : 'bg-mint-600 text-white hover:bg-mint-700')}
                >
                  {applyMut.isPending && applyMut.variables?.id === t.id ? 'Aplicando…' : active ? '✓ Aplicada — reaplicar' : 'Aplicar plantilla'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
