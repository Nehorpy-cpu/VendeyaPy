/**
 * Capa de acceso al Simulador del agente (panel · P17).
 * El dueño guarda casos de prueba y los corre contra el bot real (devMessage).
 */

import { collection, doc, getDocs, setDoc, deleteDoc, updateDoc, query, orderBy, serverTimestamp } from 'firebase/firestore';
import type { AgentTestCase, AgentTestStatus } from '@vpw/shared';
import { firebaseDb } from './firebase';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';
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

export async function upsertTestCase(tenantId: string, input: TestCaseInput): Promise<string> {
  const id = input.id ?? doc(casesCol(tenantId)).id;
  await setDoc(
    doc(casesCol(tenantId), id),
    {
      id,
      tenantId,
      name: input.name,
      scenario: input.scenario,
      userMessage: input.userMessage,
      expectedBehavior: input.expectedBehavior,
      updatedAt: serverTimestamp(),
      ...(input.id ? {} : { lastResult: '', lastRunAt: null, status: 'UNTESTED', createdAt: serverTimestamp() }),
    },
    { merge: true },
  );
  return id;
}

export async function deleteTestCase(tenantId: string, id: string): Promise<void> {
  await deleteDoc(doc(casesCol(tenantId), id));
}

export async function setTestStatus(tenantId: string, id: string, status: AgentTestStatus): Promise<void> {
  await updateDoc(doc(casesCol(tenantId), id), { status });
}

/** Corre el caso contra el bot real: 'hola' (saludo) + el userMessage; guarda la respuesta. */
export async function runTestCase(tenantId: string, tc: AgentTestCase): Promise<string> {
  const phone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
  const send = (text: string) =>
    fetch(`${API}/devMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: phone, text, tenantId }) }).then((r) => r.json());
  await send('hola');
  const r = await send(tc.userMessage);
  const reply = r.reply || (r.handledByHuman ? '(el bot está en pausa)' : '(sin respuesta)');
  await updateDoc(doc(casesCol(tenantId), tc.id), { lastResult: reply, lastRunAt: serverTimestamp() });
  return reply;
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
