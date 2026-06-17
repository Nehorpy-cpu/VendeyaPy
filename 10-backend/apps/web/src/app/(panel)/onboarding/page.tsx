'use client';

import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveCompany } from '@/lib/active-company';
import { INDUSTRY_TEMPLATES, applyTemplate, type IndustryTemplate } from '@/lib/templates';
import { getAgentConfig, getCheckoutConfig } from '@/lib/agent-config';
import { listProducts } from '@/lib/catalog';
import { listCustomers } from '@/lib/conversations';

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

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;

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
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Primeros pasos 🚀</h1>
        <p className="text-sm text-gray-500">Dejá tu negocio listo para vender en unos minutos.</p>
      </div>

      {/* Progreso + checklist */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">Tu progreso</span>
          <span className="text-sm text-gray-500">{doneCount}/{steps.length}</span>
        </div>
        <div className="mb-4 h-2 w-full rounded-full bg-gray-100">
          <div className="h-2 rounded-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <ul className="space-y-2">
          {steps.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={'flex h-5 w-5 items-center justify-center rounded-full text-xs ' + (s.done ? 'bg-brand-600 text-white' : 'border border-gray-300 text-gray-400')}>{s.done ? '✓' : ''}</span>
                <div>
                  <div className={'text-sm ' + (s.done ? 'text-gray-400 line-through' : 'text-gray-800')}>{s.label}</div>
                  {!s.done && <div className="text-xs text-gray-400">{s.hint}</div>}
                </div>
              </div>
              {!s.done && !s.href.startsWith('#') && (
                <Link href={s.href} className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-brand-700 hover:bg-gray-50">Ir</Link>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Plantillas por rubro */}
      <div id="rubro">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-gray-500">Elegí tu rubro</h2>
        <p className="mb-3 text-xs text-gray-500">Aplicar una plantilla precarga el nombre y tono del agente, su saludo, reglas de venta, preguntas frecuentes y categorías típicas. Después podés ajustar todo.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {INDUSTRY_TEMPLATES.map((t) => {
            const active = industry === t.id;
            return (
              <div key={t.id} className={'rounded-xl border bg-white p-4 ' + (active ? 'border-brand-500 ring-1 ring-brand-200' : 'border-gray-200')}>
                <div className="text-3xl">{t.emoji}</div>
                <div className="mt-1 font-semibold text-gray-900">{t.rubro}</div>
                <div className="mt-1 text-xs text-gray-500">Agente “{t.agent.agentName}” · {t.categories.length} categorías · {t.agent.faq.length} FAQ</div>
                <button
                  onClick={() => applyMut.mutate(t)}
                  disabled={applyMut.isPending}
                  className={'mt-3 w-full rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-60 ' + (active ? 'border border-brand-500 text-brand-700 hover:bg-brand-50' : 'bg-brand-600 text-white hover:bg-brand-700')}
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
