'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentConfig, BankAccount, Seller, AuditStatus } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import {
  getAgentConfig,
  saveAgentConfig,
  getCheckoutConfig,
  saveCheckoutConfig,
  DEFAULT_AGENT,
} from '@/lib/agent-config';
import { listOpenAudits, setAuditStatus, generateAudits } from '@/lib/audits';
import { canRunPanelJobs, friendlyJobError } from '@/lib/entitlements';
import { isDevToolingAllowed } from '@/lib/integrations';
import { AgentTestChat } from '@/components/AgentTestChat';
import { SectionHeader, EmptyState, SkeletonList } from '@/components/ui';
import { EstadoDeAccion } from '@/components/ui/EstadoDeAccion';
import { avisoDeLectura } from '@/lib/lectura';

const field = 'w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30';
const lbl = 'mb-1 block text-xs font-medium text-ink-600';

export default function AgentPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { claims } = useAuth();
  const qc = useQueryClient();

  const agentQ = useQuery({ queryKey: ['agentConfig', tenantId], queryFn: () => getAgentConfig(tenantId!), enabled: !!tenantId });
  const checkoutQ = useQuery({ queryKey: ['checkoutConfig', tenantId], queryFn: () => getCheckoutConfig(tenantId!), enabled: !!tenantId });
  const auditsQ = useQuery({ queryKey: ['agentAudits', tenantId], queryFn: () => listOpenAudits(tenantId!), enabled: !!tenantId });
  const auditStatusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: AuditStatus }) => setAuditStatus(tenantId!, id, status),
    onSuccess: async () => { setErrorAuditoria(null); await qc.invalidateQueries({ queryKey: ['agentAudits', tenantId] }); },
    // H-03: sin esta rama, «Resuelto»/«Descartar» rebotaban y la fila quedaba igual, sin decir nada.
    onError: (e) => setErrorAuditoria(friendlyJobError(e)),
  });
  const auditGenMut = useMutation({
    mutationFn: () => generateAudits(tenantId!),
    onSuccess: async () => { setErrorAuditoria(null); await qc.invalidateQueries({ queryKey: ['agentAudits', tenantId] }); },
    onError: (e) => setErrorAuditoria(friendlyJobError(e)),
  });

  const [agent, setAgent] = useState<AgentConfig>(DEFAULT_AGENT);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [saved, setSaved] = useState(false);
  /** H-03: el motivo del rechazo del backend, visible hasta el proximo intento. */
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);
  /** H-03: lo mismo para las acciones sobre los hallazgos de la auditoría del agente. */
  const [errorAuditoria, setErrorAuditoria] = useState<string | null>(null);

  // Cambiar de empresa no remonta la pantalla: sin esto el aviso anterior queda colgado.
  useEffect(() => { setErrorGuardado(null); setErrorAuditoria(null); setSaved(false); }, [tenantId]);

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
      setErrorGuardado(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
    // H-03: sin esto, un rechazo del backend (p. ej. reglas de venta que superan el tope) dejaba
    // la pantalla MUDA y el trabajo se perdía al recargar. El estado local NO se toca: lo que el
    // dueño escribió sigue en el formulario para que pueda corregirlo y reintentar.
    onError: (e) => {
      setSaved(false);
      // El prefijo dice QUÉ falló; el helper agrega el motivo del backend (p. ej. el tope de
      // caracteres). Sin el prefijo, el dueño lee el motivo sin saber a qué acción corresponde.
      // «todo» y no «la configuración»: son dos escrituras seguidas (agente y cobro) y la primera
      // puede haber salido bien.
      setErrorGuardado('No se pudo guardar todo. ' + friendlyJobError(e));
    },
  });

  const set = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) => setAgent((s) => ({ ...s, [k]: v }));
  // "Revisar ahora" (auditoría) llama al callable real runTenantJob('generateAudits') → visible para
  // roles con permiso de jobs (owner/manager/admin). El chat de prueba en vivo sigue usando devMessage
  // (404 en prod): solo en local/emulador; en prod se apunta al Simulador (callable real).
  const canJobs = canRunPanelJobs(claims.role);
  const devTools = isDevToolingAllowed();

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para configurar su agente." />;
  // Las DOS lecturas alimentan el formulario (`agent` una, `banks`/`sellers` la otra): mientras
  // cualquiera esté en vuelo no se muestra nada editable, porque lo editable saldría vacío.
  if (agentQ.isLoading || checkoutQ.isLoading) return <SkeletonList rows={5} />;

  // H-15 (pérdida de datos): con la lectura caída, `agent` queda en DEFAULT_AGENT y `banks`/`sellers`
  // vacíos. Guardar eso PISA la configuración real del tenant. Se avisa y se bloquea el guardado.
  // `isError` también se enciende cuando falla un REFETCH teniendo datos buenos cargados — y este
  // mismo guardado invalida las dos queries, así que un hipo de red después de guardar bien
  // encendería el cartel. Solo importa el error que dejó a la pantalla SIN datos.
  const avisoLectura =
    avisoDeLectura(agentQ, 'la configuración de tu agente') ?? avisoDeLectura(checkoutQ, 'tus datos de cobro');
  // Solo se guarda sobre datos que SE LEYERON: lo que se ve viene de `data`, y sin `data` el
  // formulario muestra los valores por defecto.
  const puedeGuardar = !!agentQ.data && !!checkoutQ.data;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      {/* Configuración */}
      <div className="space-y-6 xl:col-span-2">
        <SectionHeader
          title="Configuración del agente"
          subtitle="Definí cómo responde tu bot de WhatsApp: identidad, mensajes y reglas de venta."
          actions={
            <>
              {saved && <span className="text-sm font-medium text-mint-700">✓ Guardado</span>}
              <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || !puedeGuardar} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">
                {saveMut.isPending ? 'Guardando…' : 'Guardar cambios'}
              </button>
            </>
          }
        />

        {/* H-15: lo que se ve NO es la configuración del tenant; guardarla la destruiría. */}
        {avisoLectura && (
          <EstadoDeAccion
            tipo="error"
            mensaje={`${avisoLectura} Mientras tanto, lo de abajo NO es lo que tenés guardado y el botón de guardar está bloqueado para no pisar tu configuración real.`}
          />
        )}

        {/* H-03: el resultado del guardado, dicho en pantalla y anunciado a lectores. */}
        <EstadoDeAccion tipo="error" mensaje={errorGuardado} />

        {/* Auditoría del agente (P16) */}
        <Section title="🔍 Auditoría del agente">
          <div className="mb-2 flex items-center justify-between">
            {/* H-15: `data?.length ?? 0` convertía una lectura FALLIDA en «✓ Sin hallazgos» — un
                tilde verde sobre algo que nunca se leyó. Los tres estados van separados. */}
            <span className="text-xs text-ink-500">
              {auditsQ.isError
                ? 'No pudimos leer la auditoría. Recargá la página para intentar de nuevo.'
                : auditsQ.isLoading
                  ? 'Revisando…'
                  : (auditsQ.data?.length ?? 0) === 0
                    ? '✓ Sin hallazgos.'
                    : `${auditsQ.data!.length} hallazgo(s) para revisar.`}
            </span>
            {canJobs && (
              <button onClick={() => auditGenMut.mutate()} disabled={auditGenMut.isPending} className="text-xs font-medium text-mint-700 hover:text-mint-600 disabled:opacity-50">
                {auditGenMut.isPending ? 'Revisando…' : 'Revisar ahora'}
              </button>
            )}
          </div>
          {/* Antes era un <p> a mano sin role="alert": el fallo no se anunciaba a un lector de pantalla. */}
          <EstadoDeAccion tipo="error" mensaje={errorAuditoria} className="mb-2" />
          <div className="space-y-2">
            {(auditsQ.data ?? []).map((a) => (
              <div key={a.id} className="flex items-start gap-2 rounded-xl border border-ink-100 p-2.5">
                <span className={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + (a.severity === 'HIGH' ? 'bg-coral-500' : a.severity === 'MEDIUM' ? 'bg-amber-500' : 'bg-ink-300')} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink-800">{a.summary}</div>
                  <div className="text-xs text-ink-500">👉 {a.recommendedFix}</div>
                  <div className="mt-1 flex gap-3">
                    <button onClick={() => auditStatusMut.mutate({ id: a.id, status: 'RESOLVED' })} className="text-xs font-medium text-mint-700 hover:text-mint-600">Resuelto</button>
                    <button onClick={() => auditStatusMut.mutate({ id: a.id, status: 'DISMISSED' })} className="text-xs text-ink-500 hover:text-ink-700">Descartar</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Control del bot */}
        <Section title="Estado del bot">
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" className="accent-mint-600" checked={agent.botEnabled} onChange={(e) => set('botEnabled', e.target.checked)} />
            Bot encendido {agent.botEnabled ? '🟢' : '🔴 (no responde)'}
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" className="accent-mint-600" checked={agent.testMode} onChange={(e) => set('testMode', e.target.checked)} /> Modo prueba
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" className="accent-mint-600" checked={agent.profitMode} onChange={(e) => set('profitMode', e.target.checked)} />
            💰 Modo Ganancia {agent.profitMode ? '(prioriza productos rentables)' : ''}
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
          <ClientVisibleWarning />
          <textarea className={field} rows={4} value={agent.salesRules} onChange={(e) => set('salesRules', e.target.value)} placeholder="Ej: ofrecé una alternativa si no hay stock; sé breve y amable; pedí el dato de envío antes de cerrar…" />
        </Section>

        {/* FAQ */}
        <Section title="Preguntas frecuentes">
          <ClientVisibleWarning />
          {agent.faq.map((item, i) => (
            <div key={i} className="mb-2 flex gap-2">
              <input className={field} placeholder="Pregunta" value={item.q} onChange={(e) => set('faq', agent.faq.map((x, j) => j === i ? { ...x, q: e.target.value } : x))} />
              <input className={field} placeholder="Respuesta" value={item.a} onChange={(e) => set('faq', agent.faq.map((x, j) => j === i ? { ...x, a: e.target.value } : x))} />
              <button onClick={() => set('faq', agent.faq.filter((_, j) => j !== i))} className="px-2 text-coral-600 hover:text-coral-700">✕</button>
            </div>
          ))}
          <button onClick={() => set('faq', [...agent.faq, { q: '', a: '' }])} className="text-sm font-medium text-mint-700 hover:text-mint-600">+ Agregar FAQ</button>
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
                <button onClick={() => setBanks(banks.filter((_, j) => j !== i))} className="px-2 text-coral-600 hover:text-coral-700">✕</button>
              </div>
            </div>
          ))}
          <button onClick={() => setBanks([...banks, { bank: '', accountNumber: '', holder: '', document: '' }])} className="text-sm font-medium text-mint-700 hover:text-mint-600">+ Agregar cuenta</button>
        </Section>

        {/* Vendedores */}
        <Section title="Vendedores (handoff)">
          {sellers.map((s, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              <input className={field} placeholder="Nombre" value={s.name} onChange={(e) => setSellers(sellers.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <input className={field} placeholder="WhatsApp (+595…)" value={s.whatsapp} onChange={(e) => setSellers(sellers.map((x, j) => j === i ? { ...x, whatsapp: e.target.value } : x))} />
              <label className="flex items-center gap-1 text-xs text-ink-600"><input type="checkbox" className="accent-mint-600" checked={s.active} onChange={(e) => setSellers(sellers.map((x, j) => j === i ? { ...x, active: e.target.checked } : x))} /> activo</label>
              <button onClick={() => setSellers(sellers.filter((_, j) => j !== i))} className="px-2 text-coral-600 hover:text-coral-700">✕</button>
            </div>
          ))}
          <button onClick={() => setSellers([...sellers, { name: '', whatsapp: '+595', active: true }])} className="text-sm font-medium text-mint-700 hover:text-mint-600">+ Agregar vendedor</button>
        </Section>
      </div>

      {/* Chat de prueba */}
      <div className="xl:col-span-1">
        <div className="sticky top-4">
          {devTools ? (
            <>
              <AgentTestChat tenantId={tenantId} />
              <p className="mt-2 text-xs text-ink-400">
                Guardá los cambios para que el chat de prueba use la nueva configuración.
              </p>
            </>
          ) : (
            <div className="rounded-xl border border-ink-200 bg-white p-5 text-sm text-ink-600 shadow-soft">
              <div className="mb-1 font-semibold text-ink-800">🧪 Probá tu agente</div>
              <p className="text-xs text-ink-500">
                Guardá los cambios y probá cómo responde el bot desde el{' '}
                <a href="/simulator" className="font-medium text-mint-700 hover:text-mint-600">Simulador del agente</a>. Corre el mismo bot que WhatsApp, sin enviar mensajes reales.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-ink-100 bg-white p-5 shadow-soft">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">{title}</h2>
      {children}
    </div>
  );
}

/** Aviso para campos de texto libre que el bot puede mostrarle al cliente (salesRules, FAQ, notas IA). */
function ClientVisibleWarning() {
  return (
    <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      ⚠️ Este contenido puede ser usado por el bot al responder a clientes. No incluyas costos, márgenes, datos internos, campañas privadas ni información sensible.
    </p>
  );
}
