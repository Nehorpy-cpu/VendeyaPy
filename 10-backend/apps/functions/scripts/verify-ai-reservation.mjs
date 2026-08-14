/**
 * verify-ai-reservation.mjs — E2E de la reserva transaccional de cuota IA (ADR-0018)
 * ==================================================================================
 * CONCURRENCIA REAL contra el emulador de Firestore (transacciones de verdad, no mocks):
 * procesos paralelos compitiendo por la misma capacidad y por la misma clave. Requiere el
 * emulador levantado (--project demo-aiafg) y el build fresco (lib/).
 *
 *   node scripts/verify-ai-reservation.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.GCLOUD_PROJECT ??= 'demo-aiafg';
// getConfig() valida el env completo: cargar .env.local sin pisar lo ya seteado.
const envLocal = join(raiz, '.env.local');
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const { initializeApp, getApps } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();

const { reservarTurnoDeIa, runAiReservationSweep, AI_RESERVATION_LEASE_MS } = await import(
  new URL('../lib/entitlements/aiReservation.js', import.meta.url).href
);

let ok = 0, fail = 0;
const check = (nombre, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✅ ${nombre}`); }
  else { fail++; console.log(`  ❌ ${nombre}${extra ? ` — ${extra}` : ''}`); }
};

const T1 = 'e2e_reserva_a';
const T2 = 'e2e_reserva_b';
const now = Timestamp.now();

async function sembrarPlan(id, maxAiTokensPerMonth) {
  await db.doc(`plans/${id}`).set({
    id, tier: id.toUpperCase(), name: id, description: 'e2e', priceUsdPerMonth: 0, pricePygPerMonth: 0,
    limits: { maxProducts: 100, maxOrdersPerMonth: 100, maxWhatsappMessagesPerMonth: 1000, maxDeliveryPersons: 5, maxUsers: 5, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth },
    features: { aiAssistant: true, marketingAutomation: false },
  });
}
async function sembrarTenant(t, planId) {
  await db.doc(`tenants/${t}`).set({
    id: t, name: t, planId, status: 'ACTIVE', isDemo: false,
    subscription: { status: 'none', planId },
    usage: { aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, aiTokensReserved: 0, ordersThisMonth: 0, messagesThisMonth: 0, jobsThisMonth: 0, adSyncsThisMonth: 0, currentPeriodStart: now },
    createdAt: now, updatedAt: now,
  });
}

// Limpieza previa (ids propios de este script; idempotente).
for (const t of [T1, T2]) {
  const res = await db.collection(`tenants/${t}/aiReservations`).get();
  for (const d of res.docs) await d.ref.delete();
  const nots = await db.collection(`tenants/${t}/notifications`).get();
  for (const d of nots.docs) await d.ref.delete();
}
await sembrarPlan('e2e-starter', 3_000);
await sembrarPlan('free', 0);
await sembrarTenant(T1, 'e2e-starter');
await sembrarTenant(T2, 'e2e-starter');

const usageDe = async (t) => (await db.doc(`tenants/${t}`).get()).data().usage;
const CTX = { context: 'whatsapp_sales_agent' };

console.log('— 1/6: misma clave en paralelo —');
const [a, b] = await Promise.all([
  reservarTurnoDeIa(T1, 'ventas-mismawamid', 1000, CTX),
  reservarTurnoDeIa(T1, 'ventas-mismawamid', 1000, CTX),
]);
let u = await usageDe(T1);
check('1. dos procesos, misma clave ⇒ UNA reserva (reservado=1000, ningún handle cerrado)',
  u.aiTokensReserved === 1000 && !a.cerrada && !b.cerrada, `reservado=${u.aiTokensReserved}`);

console.log('— 2/6: carrera por la capacidad (límite 3000, ya hay 1000) —');
const rs = await Promise.allSettled(
  [1, 2, 3, 4, 5].map((i) => reservarTurnoDeIa(T1, `ventas-carrera${i}`, 900, CTX)),
);
const admitidas = rs.filter((r) => r.status === 'fulfilled').length;
u = await usageDe(T1);
check('2. de 5 reservas de 900 entran EXACTAMENTE 2 (1000+2×900=2800 ≤ 3000) y el agregado no se excede',
  admitidas === 2 && u.aiTokensReserved === 2_800,
  `admitidas=${admitidas} reservado=${u.aiTokensReserved}`);
check('2b. las rechazadas fallan con resource-exhausted',
  rs.filter((r) => r.status === 'rejected').every((r) => r.reason?.code === 'resource-exhausted'));

console.log('— 3/6: liquidación exactamente-una-vez (en paralelo) —');
const [l1, l2] = await Promise.all([
  a.liquidar({ inputTokens: 500, outputTokens: 100 }, 0.01),
  b.liquidar({ inputTokens: 500, outputTokens: 100 }, 0.01),
]);
u = await usageDe(T1);
check('3. dos liquidaciones concurrentes de la MISMA reserva ⇒ una aplica, 600 liquidados, estimación devuelta',
  (l1.aplicada !== l2.aplicada) && u.aiTokensThisMonth === 600 && u.aiTokensReserved === 1_800,
  `aplicadas=${[l1.aplicada, l2.aplicada]} settled=${u.aiTokensThisMonth} reservado=${u.aiTokensReserved}`);

console.log('— 4/6: liberación —');
const admitida = rs.find((r) => r.status === 'fulfilled').value;
await admitida.liberar('proveedor_no_configurado');
u = await usageDe(T1);
check('4. liberar devuelve la capacidad completa (1800−900=900) sin liquidar nada',
  u.aiTokensReserved === 900 && u.aiTokensThisMonth === 600, `reservado=${u.aiTokensReserved}`);

console.log('— 5/6: vencimiento y recuperación —');
const barrido = await runAiReservationSweep({ nowMs: Date.now() + AI_RESERVATION_LEASE_MS + 60_000 });
u = await usageDe(T1);
const vencidasDocs = (await db.collection(`tenants/${T1}/aiReservations`).where('status', '==', 'vencida').get()).size;
check('5. el barrido vence la reserva huérfana restante y devuelve su capacidad (reservado=0)',
  barrido.vencidas >= 1 && u.aiTokensReserved === 0 && vencidasDocs >= 1,
  `vencidas=${barrido.vencidas} reservado=${u.aiTokensReserved}`);

console.log('— 6/6: alertas idempotentes y aislamiento —');
// T2: límite 3000; liquidar 2400 (80%) dos veces con claves distintas ⇒ SOLO el umbral 70, una vez.
const r1 = await reservarTurnoDeIa(T2, 'ventas-alert1', 1200, CTX);
await r1.liquidar({ inputTokens: 1200, outputTokens: 0 }, 0.01);
const r2 = await reservarTurnoDeIa(T2, 'ventas-alert2', 1200, CTX);
await r2.liquidar({ inputTokens: 1200, outputTokens: 0 }, 0.01);
const notsT2 = (await db.collection(`tenants/${T2}/notifications`).get()).docs.map((d) => d.data());
check('6. 2400/3000 (80%) ⇒ exactamente UNA alerta (umbral 70), categoría ai_quota',
  notsT2.length === 1 && notsT2[0].category === 'ai_quota' && notsT2[0].type === 'ai_quota_70',
  `alertas=${notsT2.map((n) => n.type).join(',')}`);
// T1 recibió 3 rechazos por capacidad en el check 2 ⇒ exactamente UNA alerta `agotada`
// (aviso al bloquear, idempotente) — y ninguna de las alertas de T2 se cruzó.
const notsT1 = (await db.collection(`tenants/${T1}/notifications`).get()).docs.map((d) => d.data());
check('6b. aislamiento + aviso al bloquear: T1 tiene SOLO su alerta agotada (1, pese a 3 rechazos) y sus contadores intactos',
  notsT1.length === 1 && notsT1[0].type === 'ai_quota_agotada' && (await usageDe(T1)).aiTokensThisMonth === 600,
  `notsT1=${notsT1.map((n) => n.type).join(',')}`);
const sinPii = [...notsT2, ...notsT1].every((n) => !/\+?\d{9,}|prompt|Bearer|sk-/i.test(`${n.title} ${n.body} ${n.type} ${n.category}`));
check('6c. título/cuerpo de las alertas sin PII, teléfonos, prompts ni secretos', sinPii);

console.log(`\nRESULTADO AI-RESERVATION (reserva de cuota IA): ${fail === 0 ? 'TODO OK ✅' : 'FALLAS ❌'} (${ok}/${ok + fail})`);
process.exit(fail === 0 ? 0 : 1);
