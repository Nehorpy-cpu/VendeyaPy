/**
 * export-tenant.mjs — Exporta los datos de una empresa a un JSON (Fase 6)
 * =======================================================================
 * Para backup, portabilidad de datos (privacidad) y soporte. Lee vía Admin SDK
 * (ignora reglas). Por defecto NO incluye datos financieros privados (costos/ganancia);
 * agregá --include-private para incluirlos.
 *
 * USO:
 *   # contra el emulador (default si no seteás FIRESTORE_EMULATOR_HOST):
 *   node scripts/export-tenant.mjs perfumeria ./perfumeria-export.json
 *   # contra producción: setear GOOGLE_APPLICATION_CREDENTIALS y NO setear *_EMULATOR_HOST
 *   GOOGLE_APPLICATION_CREDENTIALS=./sa.json node scripts/export-tenant.mjs <tenantId> out.json --include-private
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { writeFileSync } from 'node:fs';

const tenantId = process.argv[2] || 'perfumeria';
const outPath = process.argv[3] || `${tenantId}-export.json`;
const includePrivate = process.argv.includes('--include-private');

// Si nadie seteó el emulador y no hay credenciales, apuntá al emulador local.
if (!process.env.FIRESTORE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
}
process.env.GCLOUD_PROJECT ??= 'demo-aiafg';

initializeApp(process.env.GOOGLE_APPLICATION_CREDENTIALS ? { credential: applicationDefault() } : { projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();

const PUBLIC_COLLECTIONS = [
  'products', 'categories', 'customers', 'orders', 'promotions', 'insights',
  'followUpTasks', 'trackingSources', 'metaConnections', 'metaAssets',
  'metaCampaigns', 'businessEvents', 'auditLogs', 'config',
];
const PRIVATE_COLLECTIONS = ['productFinancials', 'orderFinancials', 'statsDaily'];

async function dump(path) {
  const snap = await db.collection(path).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

const tenant = (await db.doc(`tenants/${tenantId}`).get()).data() ?? null;
const cols = includePrivate ? [...PUBLIC_COLLECTIONS, ...PRIVATE_COLLECTIONS] : PUBLIC_COLLECTIONS;
const collections = {};
for (const c of cols) collections[c] = await dump(`tenants/${tenantId}/${c}`);

const counts = Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length]));
const out = { tenantId, exportedAt: new Date().toISOString(), includePrivate, tenant, counts, collections };
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`✅ Exportada empresa "${tenantId}" → ${outPath}`);
console.log('   Conteos:', JSON.stringify(counts));
console.log('   Nota: los mensajes de chat (subcolección por cliente) no se incluyen en este export básico.');
process.exit(0);
