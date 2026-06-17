'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentConfig, BankAccount, Seller } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import {
  getAgentConfig,
  saveAgentConfig,
  getCheckoutConfig,
  saveCheckoutConfig,
  DEFAULT_AGENT,
} from '@/lib/agent-config';
import { AgentTestChat } from '@/components/AgentTestChat';

const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';
const lbl = 'mb-1 block text-xs font-medium text-gray-600';

export default function AgentPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();

  const agentQ = useQuery({ queryKey: ['agentConfig', tenantId], queryFn: () => getAgentConfig(tenantId!), enabled: !!tenantId });
  const checkoutQ = useQuery({ queryKey: ['checkoutConfig', tenantId], queryFn: () => getCheckoutConfig(tenantId!), enabled: !!tenantId });

  const [agent, setAgent] = useState<AgentConfig>(DEFAULT_AGENT);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (agentQ.data) setAgent(agentQ.data); }, [agentQ.data]);
  useEffect(() => { if (checkoutQ.data) { setBanks(checkoutQ.data.bankAccounts); setSellers(checkoutQ.data.sellers); } }, [checkoutQ.data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      await saveAgentConfig(tenantId!, agent);
      await saveCheckoutConfig(tenantId!, { bankAccounts: banks, sellers });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agentConfig', tenantId] });
      qc.invalidateQueries({ queryKey: ['checkoutConfig', tenantId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const set = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) => setAgent((s) => ({ ...s, [k]: v }));

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;
  if (agentQ.isLoading) return <div className="text-gray-400">Cargando configuración…</div>;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      {/* Configuración */}
      <div className="space-y-6 xl:col-span-2">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Configuración del agente</h1>
          <div className="flex items-center gap-3">
            {saved && <span className="text-sm text-brand-700">✓ Guardado</span>}
            <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
              {saveMut.isPending ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </div>

        {/* Control del bot */}
        <Section title="Estado del bot">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={agent.botEnabled} onChange={(e) => set('botEnabled', e.target.checked)} />
            Bot encendido {agent.botEnabled ? '🟢' : '🔴 (no responde)'}
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={agent.testMode} onChange={(e) => set('testMode', e.target.checked)} /> Modo prueba
          </label>
        </Section>

        {/* Identidad */}
        <Section title="Identidad">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><label className={lbl}>Nombre del agente</label><input className={field} value={agent.agentName} onChange={(e) => set('agentName', e.target.value)} /></div>
            <div><label className={lbl}>Nombre del negocio</label><input className={field} value={agent.businessName} onChange={(e) => set('businessName', e.target.value)} /></div>
            <div><label className={lbl}>Tono</label><input className={field} value={agent.tone} onChange={(e) => set('tone', e.target.value)} placeholder="amable, vendedor, formal…" /></div>
            <div><label className={lbl}>Idioma</label><input className={field} value={agent.language} onChange={(e) => set('language', e.target.value)} /></div>
          </div>
        </Section>

        {/* Mensajes */}
        <Section title="Mensajes">
          <div className="space-y-3">
            <div><label className={lbl}>Saludo inicial (vacío = usar el predeterminado)</label><textarea className={field} rows={2} value={agent.greetingMessage} onChange={(e) => set('greetingMessage', e.target.value)} /></div>
            <div><label className={lbl}>Cuando no entiende</label><input className={field} value={agent.fallbackMessage} onChange={(e) => set('fallbackMessage', e.target.value)} /></div>
            <div><label className={lbl}>Al derivar a vendedor</label><input className={field} value={agent.handoffMessage} onChange={(e) => set('handoffMessage', e.target.value)} /></div>
            <div><label className={lbl}>Despedida</label><input className={field} value={agent.farewellMessage} onChange={(e) => set('farewellMessage', e.target.value)} /></div>
          </div>
        </Section>

        {/* Reglas de venta */}
        <Section title="Reglas de venta (las usará el cerebro de IA)">
          <textarea className={field} rows={4} value={agent.salesRules} onChange={(e) => set('salesRules', e.target.value)} placeholder="Ej: priorizar productos con buen margen; no descontar bajo el costo; ofrecer alternativa si no hay stock…" />
        </Section>

        {/* FAQ */}
        <Section title="Preguntas frecuentes">
          {agent.faq.map((item, i) => (
            <div key={i} className="mb-2 flex gap-2">
              <input className={field} placeholder="Pregunta" value={item.q} onChange={(e) => set('faq', agent.faq.map((x, j) => j === i ? { ...x, q: e.target.value } : x))} />
              <input className={field} placeholder="Respuesta" value={item.a} onChange={(e) => set('faq', agent.faq.map((x, j) => j === i ? { ...x, a: e.target.value } : x))} />
              <button onClick={() => set('faq', agent.faq.filter((_, j) => j !== i))} className="px-2 text-red-600">✕</button>
            </div>
          ))}
          <button onClick={() => set('faq', [...agent.faq, { q: '', a: '' }])} className="text-sm text-brand-700 hover:underline">+ Agregar FAQ</button>
        </Section>

        {/* Cuentas bancarias */}
        <Section title="Cuentas bancarias (para transferencias)">
          {banks.map((b, i) => (
            <div key={i} className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-4">
              <input className={field} placeholder="Banco" value={b.bank} onChange={(e) => setBanks(banks.map((x, j) => j === i ? { ...x, bank: e.target.value } : x))} />
              <input className={field} placeholder="N° cuenta" value={b.accountNumber} onChange={(e) => setBanks(banks.map((x, j) => j === i ? { ...x, accountNumber: e.target.value } : x))} />
              <input className={field} placeholder="Titular" value={b.holder} onChange={(e) => setBanks(banks.map((x, j) => j === i ? { ...x, holder: e.target.value } : x))} />
              <div className="flex gap-1">
                <input className={field} placeholder="CI/RUC" value={b.document} onChange={(e) => setBanks(banks.map((x, j) => j === i ? { ...x, document: e.target.value } : x))} />
                <button onClick={() => setBanks(banks.filter((_, j) => j !== i))} className="px-2 text-red-600">✕</button>
              </div>
            </div>
          ))}
          <button onClick={() => setBanks([...banks, { bank: '', accountNumber: '', holder: '', document: '' }])} className="text-sm text-brand-700 hover:underline">+ Agregar cuenta</button>
        </Section>

        {/* Vendedores */}
        <Section title="Vendedores (handoff)">
          {sellers.map((s, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              <input className={field} placeholder="Nombre" value={s.name} onChange={(e) => setSellers(sellers.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <input className={field} placeholder="WhatsApp (+595…)" value={s.whatsapp} onChange={(e) => setSellers(sellers.map((x, j) => j === i ? { ...x, whatsapp: e.target.value } : x))} />
              <label className="flex items-center gap-1 text-xs text-gray-600"><input type="checkbox" checked={s.active} onChange={(e) => setSellers(sellers.map((x, j) => j === i ? { ...x, active: e.target.checked } : x))} /> activo</label>
              <button onClick={() => setSellers(sellers.filter((_, j) => j !== i))} className="px-2 text-red-600">✕</button>
            </div>
          ))}
          <button onClick={() => setSellers([...sellers, { name: '', whatsapp: '+595', active: true }])} className="text-sm text-brand-700 hover:underline">+ Agregar vendedor</button>
        </Section>
      </div>

      {/* Chat de prueba */}
      <div className="xl:col-span-1">
        <div className="sticky top-4">
          <AgentTestChat tenantId={tenantId} />
          <p className="mt-2 text-xs text-gray-400">
            Guardá los cambios para que el chat de prueba use la nueva configuración.
          </p>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      {children}
    </div>
  );
}
