'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentTestCase, AgentTestStatus } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import {
  listTestCases,
  upsertTestCase,
  deleteTestCase,
  setTestStatus,
  runTestCase,
  seedDefaultTestCases,
  type TestCaseInput,
} from '@/lib/simulator';
import { SectionHeader, EmptyState, SkeletonList, StatusBadge, type BadgeTone } from '@/components/ui';

const STATUS_TONE: Record<AgentTestStatus, BadgeTone> = { UNTESTED: 'ink', OK: 'mint', NEEDS_WORK: 'amber' };
const STATUS_LABEL: Record<AgentTestStatus, string> = { UNTESTED: 'Sin probar', OK: 'OK', NEEDS_WORK: 'Revisar' };
const field = 'w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30';
const lbl = 'mb-1 block text-xs font-medium text-ink-600';

export default function SimulatorPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ open: boolean; tc: AgentTestCase | null }>({ open: false, tc: null });

  const casesQ = useQuery({ queryKey: ['testCases', tenantId], queryFn: () => listTestCases(tenantId!), enabled: !!tenantId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['testCases', tenantId] });
  const runMut = useMutation({ mutationFn: (tc: AgentTestCase) => runTestCase(tenantId!, tc), onSuccess: invalidate });
  const saveMut = useMutation({ mutationFn: (input: TestCaseInput) => upsertTestCase(tenantId!, input), onSuccess: () => { invalidate(); setForm({ open: false, tc: null }); } });
  const delMut = useMutation({ mutationFn: (id: string) => deleteTestCase(tenantId!, id), onSuccess: invalidate });
  const statusMut = useMutation({ mutationFn: ({ id, status }: { id: string; status: AgentTestStatus }) => setTestStatus(tenantId!, id, status), onSuccess: invalidate });
  const seedMut = useMutation({ mutationFn: () => seedDefaultTestCases(tenantId!), onSuccess: invalidate });

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para probar su agente." />;

  const cases = casesQ.data ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Simulador del agente"
        subtitle="Guardá escenarios y corrélos contra el bot para ver cómo responde."
        actions={
          <>
            <button onClick={() => seedMut.mutate()} disabled={seedMut.isPending} className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-50">Cargar ejemplos</button>
            <button onClick={() => setForm({ open: true, tc: null })} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700">+ Nuevo caso</button>
          </>
        }
      />

      {casesQ.isLoading && <SkeletonList rows={4} />}
      {casesQ.isSuccess && cases.length === 0 && (
        <EmptyState title="Sin casos todavía" text="Tocá “Cargar ejemplos” para empezar con escenarios típicos, o creá uno con “+ Nuevo caso”." />
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {cases.map((tc) => (
          <div key={tc.id} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-ink-900">{tc.name}</span>
              <StatusBadge tone={STATUS_TONE[tc.status]}>{STATUS_LABEL[tc.status]}</StatusBadge>
            </div>
            <p className="mt-1 text-xs text-ink-500">{tc.scenario}</p>
            <div className="mt-2 space-y-1 text-xs">
              <div><span className="text-ink-400">Cliente dice:</span> <span className="text-ink-800">“{tc.userMessage}”</span></div>
              <div><span className="text-ink-400">Esperado:</span> <span className="text-ink-700">{tc.expectedBehavior}</span></div>
            </div>
            {tc.lastResult && (
              <div className="mt-2 rounded-lg bg-ink-50/60 p-2 text-xs text-ink-700">
                <span className="font-semibold text-ink-500">Respuesta del bot:</span>
                <div className="mt-0.5 whitespace-pre-wrap">{tc.lastResult}</div>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={() => runMut.mutate(tc)} disabled={runMut.isPending} className="rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">
                {runMut.isPending && runMut.variables?.id === tc.id ? 'Corriendo…' : '▶ Correr'}
              </button>
              <button onClick={() => statusMut.mutate({ id: tc.id, status: 'OK' })} className="rounded-lg border border-ink-200 px-2 py-1.5 text-xs font-medium text-mint-700 transition-colors hover:bg-ink-50">✓ OK</button>
              <button onClick={() => statusMut.mutate({ id: tc.id, status: 'NEEDS_WORK' })} className="rounded-lg border border-ink-200 px-2 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-ink-50">⚠ Revisar</button>
              <span className="flex-1" />
              <button onClick={() => setForm({ open: true, tc })} className="text-xs font-medium text-mint-700 hover:text-mint-600">Editar</button>
              <button onClick={() => delMut.mutate(tc.id)} className="text-xs text-coral-600 hover:text-coral-700">Borrar</button>
            </div>
          </div>
        ))}
      </div>

      {form.open && (
        <TestForm
          initial={form.tc}
          saving={saveMut.isPending}
          onCancel={() => setForm({ open: false, tc: null })}
          onSubmit={(input) => saveMut.mutate(input)}
        />
      )}
    </div>
  );
}

function TestForm({ initial, saving, onCancel, onSubmit }: { initial: AgentTestCase | null; saving: boolean; onCancel: () => void; onSubmit: (input: TestCaseInput) => void }) {
  const [f, setF] = useState<TestCaseInput>({
    ...(initial ? { id: initial.id } : {}),
    name: initial?.name ?? '',
    scenario: initial?.scenario ?? '',
    userMessage: initial?.userMessage ?? '',
    expectedBehavior: initial?.expectedBehavior ?? '',
  });
  const set = <K extends keyof TestCaseInput>(k: K, v: TestCaseInput[K]) => setF((s) => ({ ...s, [k]: v }));
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4">
      <form onSubmit={(e) => { e.preventDefault(); onSubmit({ ...f, name: f.name.trim(), userMessage: f.userMessage.trim() }); }} className="my-8 w-full max-w-lg rounded-2xl border border-ink-100 bg-white p-6 shadow-float">
        <h2 className="mb-4 text-lg font-bold text-ink-900">{initial ? 'Editar caso' : 'Nuevo caso'}</h2>
        <div className="space-y-3">
          <div><label className={lbl}>Nombre *</label><input className={field} required value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><label className={lbl}>Escenario</label><input className={field} value={f.scenario} onChange={(e) => set('scenario', e.target.value)} placeholder="Cliente pide descuento…" /></div>
          <div><label className={lbl}>Mensaje del cliente *</label><input className={field} required value={f.userMessage} onChange={(e) => set('userMessage', e.target.value)} placeholder="lo que escribe el cliente" /></div>
          <div><label className={lbl}>Comportamiento esperado</label><textarea className={field} rows={2} value={f.expectedBehavior} onChange={(e) => set('expectedBehavior', e.target.value)} /></div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">Cancelar</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </div>
  );
}
