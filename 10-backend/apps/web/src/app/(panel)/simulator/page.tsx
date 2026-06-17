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

const STATUS_BADGE: Record<AgentTestStatus, string> = {
  UNTESTED: 'bg-gray-100 text-gray-500',
  OK: 'bg-brand-100 text-brand-700',
  NEEDS_WORK: 'bg-amber-100 text-amber-700',
};
const STATUS_LABEL: Record<AgentTestStatus, string> = { UNTESTED: 'Sin probar', OK: 'OK', NEEDS_WORK: 'Revisar' };
const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';
const lbl = 'mb-1 block text-xs font-medium text-gray-600';

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

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;

  const cases = casesQ.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Simulador del agente</h1>
          <p className="text-sm text-gray-500">Guardá escenarios y corrélos contra el bot para ver cómo responde.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => seedMut.mutate()} disabled={seedMut.isPending} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">Cargar ejemplos</button>
          <button onClick={() => setForm({ open: true, tc: null })} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">+ Nuevo caso</button>
        </div>
      </div>

      {casesQ.isLoading && <div className="text-gray-400">Cargando…</div>}
      {casesQ.isSuccess && cases.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          Sin casos todavía. Tocá “Cargar ejemplos” para empezar con escenarios típicos.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {cases.map((tc) => (
          <div key={tc.id} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-gray-900">{tc.name}</span>
              <span className={'rounded-full px-2 py-0.5 text-xs font-medium ' + STATUS_BADGE[tc.status]}>{STATUS_LABEL[tc.status]}</span>
            </div>
            <p className="mt-1 text-xs text-gray-500">{tc.scenario}</p>
            <div className="mt-2 space-y-1 text-xs">
              <div><span className="text-gray-400">Cliente dice:</span> <span className="text-gray-800">“{tc.userMessage}”</span></div>
              <div><span className="text-gray-400">Esperado:</span> <span className="text-gray-700">{tc.expectedBehavior}</span></div>
            </div>
            {tc.lastResult && (
              <div className="mt-2 rounded-lg bg-gray-50 p-2 text-xs text-gray-700">
                <span className="font-semibold text-gray-500">Respuesta del bot:</span>
                <div className="mt-0.5 whitespace-pre-wrap">{tc.lastResult}</div>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={() => runMut.mutate(tc)} disabled={runMut.isPending} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
                {runMut.isPending && runMut.variables?.id === tc.id ? 'Corriendo…' : '▶ Correr'}
              </button>
              <button onClick={() => statusMut.mutate({ id: tc.id, status: 'OK' })} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs text-brand-700 hover:bg-gray-50">✓ OK</button>
              <button onClick={() => statusMut.mutate({ id: tc.id, status: 'NEEDS_WORK' })} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs text-amber-700 hover:bg-gray-50">⚠ Revisar</button>
              <span className="flex-1" />
              <button onClick={() => setForm({ open: true, tc })} className="text-xs text-brand-700 hover:underline">Editar</button>
              <button onClick={() => delMut.mutate(tc.id)} className="text-xs text-red-600 hover:underline">Borrar</button>
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <form onSubmit={(e) => { e.preventDefault(); onSubmit({ ...f, name: f.name.trim(), userMessage: f.userMessage.trim() }); }} className="my-8 w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-bold text-gray-900">{initial ? 'Editar caso' : 'Nuevo caso'}</h2>
        <div className="space-y-3">
          <div><label className={lbl}>Nombre *</label><input className={field} required value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><label className={lbl}>Escenario</label><input className={field} value={f.scenario} onChange={(e) => set('scenario', e.target.value)} placeholder="Cliente pide descuento…" /></div>
          <div><label className={lbl}>Mensaje del cliente *</label><input className={field} required value={f.userMessage} onChange={(e) => set('userMessage', e.target.value)} placeholder="lo que escribe el cliente" /></div>
          <div><label className={lbl}>Comportamiento esperado</label><textarea className={field} rows={2} value={f.expectedBehavior} onChange={(e) => set('expectedBehavior', e.target.value)} /></div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100">Cancelar</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </div>
  );
}
