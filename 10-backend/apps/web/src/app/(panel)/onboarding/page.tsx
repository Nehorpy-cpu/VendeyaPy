'use client';

import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveCompany } from '@/lib/active-company';
import { INDUSTRY_TEMPLATES, applyTemplate, type IndustryTemplate } from '@/lib/templates';
import { getAgentConfig, getCheckoutConfig } from '@/lib/agent-config';
import { listProducts } from '@/lib/catalog';
import { listCustomers } from '@/lib/conversations';
import { SectionHeader, EmptyState } from '@/components/ui';

export default function OnboardingPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();

  const agentQ = useQuery({ queryKey: ['agentConfig', tenantId], queryFn: () => getAgentConfig(tenantId!), enabled: !!tenantId });
  const productsQ = useQuery({ queryKey: ['products', tenantId], queryFn: () => listProducts(tenantId!), enabled: !!tenantId });
  const checkoutQ = useQuery({ queryKey: ['checkoutConfig', tenantId], queryFn: () => getCheckoutConfig(tenantId!), enabled: !!tenantId });
  const customersQ = useQuery({ queryKey: ['customers', tenantId], queryFn: () => listCustomers(tenantId!), enabled: !!tenantId });

  const applyMut = useMutation({
    mutationFn: (t: IndustryTemplate) => applyTemplate(tenantId!, t),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agentConfig', tenantId] });
      qc.invalidateQueries({ queryKey: ['categories', tenantId] });
    },
  });

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para configurar sus primeros pasos." />;

  const industry = agentQ.data?.industry ?? '';
  const banks = checkoutQ.data?.bankAccounts ?? [];
  const banksOk = banks.length > 0 && !/REEMPLAZAR/i.test(banks[0]?.bank + ' ' + banks[0]?.accountNumber);
  const steps = [
    { label: 'Elegí tu rubro', done: !!industry, href: '#rubro', hint: 'Aplicá una plantilla acá abajo.' },
    { label: 'Cargá tus productos', done: (productsQ.data?.length ?? 0) > 0, href: '/catalog', hint: 'Sumá tu catálogo.' },
    { label: 'Poné tus datos bancarios', done: banksOk, href: '/agent', hint: 'Para que el bot pase los datos de pago.' },
    { label: 'Probá tu bot', done: (customersQ.data?.length ?? 0) > 0, href: '/agent', hint: 'Usá el chat de prueba en Config. del agente.' },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const pct = Math.round((doneCount / steps.length) * 100);

  return (
    <div className="space-y-6">
      <SectionHeader title="Primeros pasos 🚀" subtitle="Dejá tu negocio listo para vender en unos minutos." />

      {/* Progreso + checklist */}
      <div className="rounded-2xl border border-ink-100 bg-white p-5 shadow-soft">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-ink-700">Tu progreso</span>
          <span className="text-sm text-ink-500">{doneCount}/{steps.length}</span>
        </div>
        <div className="mb-4 h-2 w-full rounded-full bg-ink-100">
          <div className="h-2 rounded-full bg-mint-brand transition-all" style={{ width: `${pct}%` }} />
        </div>
        <ul className="space-y-2">
          {steps.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={'flex h-5 w-5 items-center justify-center rounded-full text-xs ' + (s.done ? 'bg-mint-600 text-white' : 'border border-ink-200 text-ink-400')}>{s.done ? '✓' : ''}</span>
                <div>
                  <div className={'text-sm ' + (s.done ? 'text-ink-400 line-through' : 'text-ink-800')}>{s.label}</div>
                  {!s.done && <div className="text-xs text-ink-400">{s.hint}</div>}
                </div>
              </div>
              {!s.done && !s.href.startsWith('#') && (
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
