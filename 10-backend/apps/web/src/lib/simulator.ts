/**
 * Capa de acceso al Simulador del agente (panel · P17).
 *
 * LECTURAS directas (las reglas permiten leer al manager+). ESCRITURAS y RUN por callables (Fase 5C):
 *   - agentTestCaseUpsert (alta/edición de la definición; también el cambio de status)
 *   - agentTestCaseDelete (hard-delete; dato efímero del simulador)
 *   - agentTestCaseRun     (corre el bot server-side y persiste lastResult/lastRunAt vía Admin SDK)
 * El run ya NO pega al endpoint dev `devMessage` ni escribe lastResult/lastRunAt directo.
 */

import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { AgentTestCase, AgentTestStatus } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';

const casesCol = (t: string) => collection(firebaseDb(), 'tenants', t, 'agentTestCases');

export async function listTestCases(tenantId: string): Promise<AgentTestCase[]> {
  const snap = await getDocs(query(casesCol(tenantId), orderBy('createdAt', 'asc')));
  return snap.docs.map((d) => d.data() as AgentTestCase);
}

export interface TestCaseInput {
  id?: string;
  name: string;
  scenario: string;
  userMessage: string;
  expectedBehavior: string;
}

type TestCaseUpsertResp = { ok: boolean; id: string; created: boolean };

/**
 * Alta/edición de la definición vía callable `agentTestCaseUpsert`. El backend descarta
 * lastResult/lastRunAt (server-only) y en create inicializa status='UNTESTED'. NO escribe directo.
 */
export async function upsertTestCase(tenantId: string, input: TestCaseInput): Promise<string> {
  const data = { name: input.name, scenario: input.scenario, userMessage: input.userMessage, expectedBehavior: input.expectedBehavior };
  const call = httpsCallable<{ tenantId: string; id?: string; data: unknown }, TestCaseUpsertResp>(
    firebaseFunctions(),
    'agentTestCaseUpsert',
  );
  const res = await call({ tenantId, id: input.id, data });
  return res.data.id;
}

/** Baja vía callable `agentTestCaseDelete` (hard-delete; dato efímero). NO escribe directo. */
export async function deleteTestCase(tenantId: string, id: string): Promise<void> {
  const call = httpsCallable<{ tenantId: string; id: string }, { ok: boolean }>(firebaseFunctions(), 'agentTestCaseDelete');
  await call({ tenantId, id });
}

/** Cambio de status manual vía `agentTestCaseUpsert` (data:{status}); el backend valida el enum. */
export async function setTestStatus(tenantId: string, id: string, status: AgentTestStatus): Promise<void> {
  const call = httpsCallable<{ tenantId: string; id: string; data: unknown }, { ok: boolean }>(firebaseFunctions(), 'agentTestCaseUpsert');
  await call({ tenantId, id, data: { status } });
}

/**
 * Corre el caso server-side vía callable `agentTestCaseRun`: el backend corre el bot real (toma el
 * userMessage del doc) y persiste lastResult/lastRunAt con Admin SDK. Devuelve el lastResult para
 * mostrarlo (la UI lo relee del doc tras invalidar). NO pega a `devMessage` ni escribe directo.
 */
export async function runTestCase(tenantId: string, tc: AgentTestCase): Promise<string> {
  const call = httpsCallable<{ tenantId: string; id: string }, { ok: boolean; id: string; lastResult: string; handledByHuman: boolean }>(
    firebaseFunctions(),
    'agentTestCaseRun',
  );
  const res = await call({ tenantId, id: tc.id });
  return res.data.lastResult;
}

const DEFAULTS: TestCaseInput[] = [
  { id: 'def-descuento', name: 'Pide descuento', scenario: 'El cliente pide rebaja', userMessage: '¿me hacés un descuento?', expectedBehavior: 'No ofrecer descuentos no autorizados; ser amable y mostrar valor.' },
  { id: 'def-regalo', name: 'Busca regalo', scenario: 'Quiere regalar', userMessage: 'busco un perfume para regalar a mi novia', expectedBehavior: 'Recomendar opciones femeninas.' },
  { id: 'def-barato', name: 'Algo barato', scenario: 'Presupuesto bajo', userMessage: 'algo barato que tengas', expectedBehavior: 'Mostrar opciones accesibles.' },
  { id: 'def-premium', name: 'Algo premium', scenario: 'Quiere lujo', userMessage: 'quiero algo premium', expectedBehavior: 'Mostrar opciones premium.' },
  { id: 'def-pago', name: 'Pregunta por el pago', scenario: 'Cómo pagar', userMessage: '¿cómo te puedo pagar?', expectedBehavior: 'Explicar la transferencia / dar los datos al momento de pagar.' },
  { id: 'def-reclamo', name: 'Reclamo', scenario: 'Cliente molesto', userMessage: 'esto es una estafa, quiero mi plata', expectedBehavior: 'Pasar la conversación a un vendedor humano.' },
];

export async function seedDefaultTestCases(tenantId: string): Promise<void> {
  for (const d of DEFAULTS) await upsertTestCase(tenantId, d);
}
