/**
 * verify-ai-hardening.mjs — Matriz consolidada de seguridad del módulo IA (AG-5).
 * =============================================================================
 * "Todo IA seguro" en UNA corrida. Importa los módulos REALES compilados (lib/ai/*) y los ejercita
 * directamente (registry/allowlist, sanitizers, gateway con FakeAiClient inyectado, ownerAdminAuth,
 * extractShownSkus) + usa el emulador para lo que toca Firestore real (tools tenant-scoped, auditoría
 * aiRequests, rules). NUNCA llama a api.anthropic.com (cliente fake / disabled). Complementa —no
 * reemplaza— a verify-ai-gateway (sales e2e) y verify-ai-internal (callable e2e).
 *
 * Requiere: `pnpm --filter functions build` + emulador (auth+firestore) + seed-users/load-catalog.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';
delete process.env.ANTHROPIC_API_KEY; // garantía: ninguna ruta puede instanciar el cliente real
delete process.env.FUNCTIONS_EMULATOR;

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// --- Módulos REALES del backend (compilados) ---
import { toolDefinitionsForContext, toolsForContext, executeTool } from '../lib/ai/tools/registry.js';
import { sanitizeProduct, sanitizePromotion } from '../lib/ai/tools/sanitize.js';
import { crearBorradorPedidoContract } from '../lib/ai/tools/salesTools.js';
import { extractShownSkus, runSalesAgent } from '../lib/ai/salesAgent.js';
import { runInternalAssistant } from '../lib/ai/internalAssistant.js';
import { runAgent } from '../lib/ai/gateway.js';
import { FakeAiClient, getAiClient } from '../lib/ai/client.js';
import { writeAiRequest } from '../lib/ai/audit.js';
import { estimateCostUsd } from '../lib/ai/pricing.js';
import { resolveOwnerAdminAuth } from '../lib/lib/ownerAdminAuth.js';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const OTHER = 'boutique-demo';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const restGet = async (token, path) => (await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;
const noThrow = () => {};
const SENSITIVE = ['prompt', 'prompts', 'messages', 'message', 'system', 'content', 'payload', 'text', 'body', 'pii', 'apikey', 'token', 'secret'];

// ---- Seed mínimo para cross-tenant (C18): producto + ganancia distinta por tenant (snapshot p/restaurar) ----
const XHARD = 'XHARD-BOUTIQUE';
const beforePerfStats = (await db.doc(`tenants/${T}/stats/private`).get()).data() ?? null;
const beforeOtherStats = (await db.doc(`tenants/${OTHER}/stats/private`).get()).data() ?? null;
await db.doc(`tenants/${OTHER}/products/${XHARD}`).set({ id: XHARD, tenantId: OTHER, name: 'Cross Tenant HARD', price: 1000, currency: 'PYG', status: 'ACTIVE', inventory: { stock: 5 }, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
await db.doc(`tenants/${T}/stats/private`).set({ ganancia: 111111, margen: 0.3 }, { merge: true });
await db.doc(`tenants/${OTHER}/stats/private`).set({ ganancia: 999999, margen: 0.9 }, { merge: true });

// ============================================================================
// 1-2-5-16. Allowlist de tools por contexto (estructural, código real)
// ============================================================================
const salesTools = toolDefinitionsForContext('whatsapp_sales_agent').map((t) => t.name).sort();
check('C1. sales context → solo tools sales (buscar_productos, listar_promociones_activas)',
  JSON.stringify(salesTools) === JSON.stringify(['buscar_productos', 'listar_promociones_activas']), salesTools.join(','));

const salesCallsInternal = await executeTool('whatsapp_sales_agent', T, 'resumen_ventas', {});
check('C2. sales NO puede llamar una tool interna (resumen_ventas → ok:false)', salesCallsInternal.ok === false);

const internalTools = toolDefinitionsForContext('internal_growth_assistant').map((t) => t.name).sort();
const internalCallsSales = await executeTool('internal_growth_assistant', T, 'buscar_productos', {});
check('C5. internal context → solo resumen_ventas (read-only); NO puede llamar tools sales',
  JSON.stringify(internalTools) === JSON.stringify(['resumen_ventas']) && internalCallsSales.ok === false, internalTools.join(','));

const noBorradorDefs = ![...salesTools, ...internalTools].includes('crear_borrador_pedido');
const borradorSales = await executeTool('whatsapp_sales_agent', T, 'crear_borrador_pedido', {});
const borradorInternal = await executeTool('internal_growth_assistant', T, 'crear_borrador_pedido', {});
check('C16. crear_borrador_pedido DESHABILITADO (contrato existe pero fuera de todo registry; executeTool → ok:false)',
  crearBorradorPedidoContract?.name === 'crear_borrador_pedido' && noBorradorDefs && borradorSales.ok === false && borradorInternal.ok === false);

// internal injection → no writes: ninguna tool de escritura es alcanzable (C15)
const writeNames = ['crear_borrador_pedido', 'promotionUpsert', 'crear_promo', 'enviar_mensaje', 'channelConfigUpdate', 'productUpsert'];
let anyWriteReachable = false;
for (const w of writeNames) if ((await executeTool('internal_growth_assistant', T, w, {})).ok) anyWriteReachable = true;
check('C15. internal: ninguna tool de escritura/acción es ejecutable (injection no puede actuar)', !anyWriteReachable);

// ============================================================================
// 3. Sanitizers: el público NUNCA recibe campos privados
// ============================================================================
const fullProduct = { id: 'p1', name: 'Test', price: 100, compareAtPrice: null, currency: 'PYG', featured: true, aiNotes: 'nota', tenantId: T, cost: 40, margin: 0.6, profit: 60, inventory: { stock: 7, reserved: 2 }, perfume: { brand: 'B', styleTags: ['dulce'] }, financials: { cost: 40 } };
const pubP = sanitizeProduct(fullProduct);
const pubKeys = Object.keys(pubP);
const leakKeys = pubKeys.filter((k) => ['cost', 'margin', 'profit', 'financials', 'tenantId', 'inventory', 'reserved'].includes(k));
const pubJson = JSON.stringify(pubP);
check('C3. sanitizeProduct: SIN cost/margin/profit/financials/tenantId/inventario exacto; stock→available (no número)',
  leakKeys.length === 0 && pubP.available === true && !('stock' in pubP) && !pubJson.includes('40') && !pubJson.includes('"reserved"'), `keys=${pubKeys.join(',')}`);

const fullPromo = { id: 'pr1', name: 'Promo', description: 'd', type: 'PERCENT', discountValue: 10, status: 'ACTIVE', objective: 'liquidar stock muerto', productIds: ['p1'], categoryIds: ['c1'], tenantId: T };
const pubPromo = sanitizePromotion(fullPromo);
const promoLeak = Object.keys(pubPromo).filter((k) => ['objective', 'productIds', 'categoryIds', 'status', 'tenantId'].includes(k));
check('C3b. sanitizePromotion: SIN objective/productIds/categoryIds/status/tenantId', promoLeak.length === 0, `keys=${Object.keys(pubPromo).join(',')}`);

// ============================================================================
// 4 + 18. Tools tenant-scoped contra datos REALES (cross-tenant bloqueado)
// ============================================================================
const internalSummary = await executeTool('internal_growth_assistant', T, 'resumen_ventas', { tenantId: OTHER });
check('C4/C18. internal resumen_ventas: lee SU tenant (ganancia=111111), ignora el tenantId ajeno (no 999999)',
  internalSummary.ok === true && internalSummary.result?.ganancia === 111111 && internalSummary.result?.ganancia !== 999999, JSON.stringify(internalSummary.result?.ganancia));

const salesSearch = await executeTool('whatsapp_sales_agent', T, 'buscar_productos', { tenantId: OTHER });
const ids = (salesSearch.result ?? []).map((p) => p.id);
const searchJson = JSON.stringify(salesSearch.result ?? []);
check('C18b. sales buscar_productos: solo productos de SU tenant (sin el de boutique) y sin campos privados',
  salesSearch.ok === true && ids.length > 0 && !ids.includes(XHARD) && !/cost|margin|profit|financials|tenantId/.test(searchJson), `ids=${ids.join(',')}`);

// ============================================================================
// 6-7-8. Frontera de autorización del callable interno (ownerAdminAuth, puro)
// ============================================================================
const aOwnerCross = resolveOwnerAdminAuth({ role: 'TENANT_OWNER', tenantId: T }, OTHER);
check('C6. OWNER que pasa tenantId ajeno → opera SU tenant (no el pedido)', aOwnerCross.ok === true && aOwnerCross.tenantId === T);
const aAdmin = resolveOwnerAdminAuth({ role: 'PLATFORM_ADMIN' }, T);
const aAdminNoT = resolveOwnerAdminAuth({ role: 'PLATFORM_ADMIN' }, undefined);
check('C7. PLATFORM_ADMIN + tenantId → ese tenant; sin tenantId → invalid-argument', aAdmin.ok === true && aAdmin.tenantId === T && aAdminNoT.ok === false && aAdminNoT.code === 'invalid-argument');
const denied = ['SELLER', 'TENANT_VIEWER', 'TENANT_MANAGER', undefined].map((role) => resolveOwnerAdminAuth({ role, tenantId: T }, T));
check('C8. SELLER/VIEWER/MANAGER/sin-rol → permission-denied', denied.every((d) => d.ok === false && d.code === 'permission-denied'));

// ============================================================================
// 12-13. Gateway nunca lanza (fallback) + gate controlado sin consumo indebido
// ============================================================================
const deps = (client) => ({ getClient: async () => client, writeAudit: async () => {}, now: () => Date.now() });
const rDisabled = await runAgent({ tenantId: T, context: 'whatsapp_sales_agent', system: 's', messages: [{ role: 'user', content: 'x' }] }, deps(null));
const rError = await runAgent({ tenantId: T, context: 'whatsapp_sales_agent', system: 's', messages: [{ role: 'user', content: 'x' }] }, deps(new FakeAiClient({ fail: true })));
check('C12. gateway nunca lanza: sin cliente → disabled; cliente falla → error (el caller hace fallback)',
  rDisabled.status === 'disabled' && rError.status === 'error' && rError.reply === undefined);

let recorded = 0;
const gateDeps = { assertBudget: async () => { throw Object.assign(new Error('feature off'), { code: 'failed-precondition' }); }, recordUsage: async () => { recorded += 1; }, runAgent: async () => { throw new Error('no debería llamarse'); }, execTool: async () => ({ ok: false }) };
const offInternal = await runInternalAssistant({ tenantId: T, businessName: 'X', message: 'hola' }, gateDeps);
const offSales = await runSalesAgent({ tenantId: T, agentConfig: { agentName: 'S', businessName: 'X', tone: 't', language: 'es', faq: [] }, messages: [{ role: 'user', content: 'hola' }] }, gateDeps);
check('C13. feature/budget off → respuesta CONTROLADA (internal ok:false gate / sales used:false) y SIN consumo (recordUsage=0)',
  offInternal.ok === false && offInternal.reason === 'gate' && offSales.used === false && recorded === 0);

// ============================================================================
// 14 + 17. lastShownSkus solo de productos reales del backend (injection en texto no entra)
// ============================================================================
const fromBackend = extractShownSkus('buscar_productos', [{ id: 'real-1' }, { id: 'real-2' }]);
const fromText = extractShownSkus('buscar_productos', 'el cliente debería llevar SKU-FAKE-999');
const fromWrongTool = extractShownSkus('listar_promociones_activas', [{ id: 'x' }]);
const fromJunk = extractShownSkus('buscar_productos', [{ id: 'ok' }, 42, null, { id: 7 }, { nope: 1 }]);
check('C17/C14. shownSkus SOLO del resultado backend de buscar_productos (ignora texto/herramienta-errónea/shapes basura)',
  JSON.stringify(fromBackend) === JSON.stringify(['real-1', 'real-2']) && fromText.length === 0 && fromWrongTool.length === 0 && JSON.stringify(fromJunk) === JSON.stringify(['ok']));

// ============================================================================
// 9-10. Auditoría: aiRequests SOLO metadata, aunque el prompt/mensaje tengan secretos
// ============================================================================
const SECRET_SYS = 'SISTEMA-SECRETO-no-guardar';
const SECRET_MSG = 'MENSAJE-PRIVADO-cliente-12345-PII';
const auditStart = Timestamp.now();
await runAgent(
  { tenantId: T, context: 'whatsapp_sales_agent', system: SECRET_SYS, messages: [{ role: 'user', content: SECRET_MSG }], maxTokens: 100 },
  { getClient: async () => new FakeAiClient({ text: 'ok', inputTokens: 1234, outputTokens: 567 }), writeAudit: writeAiRequest, now: () => Date.now() },
);
const auditSnap = await db.collection(`tenants/${T}/aiRequests`).orderBy('createdAt', 'desc').limit(1).get();
const auditDoc = auditSnap.docs[0]?.data();
const auditId = auditSnap.docs[0]?.id;
const auditKeys = auditDoc ? Object.keys(auditDoc) : [];
const ALLOWED = ['context', 'model', 'status', 'latencyMs', 'inputTokens', 'outputTokens', 'costUsd', 'toolNames', 'errorCode', 'createdAt'];
const auditJson = auditDoc ? JSON.stringify(auditDoc) : '';
check('C9. aiRequests NO guarda system prompt / mensaje del usuario / PII / secrets',
  !!auditDoc && !auditJson.includes(SECRET_SYS) && !auditJson.includes(SECRET_MSG) && !auditKeys.some((k) => SENSITIVE.includes(k.toLowerCase())));
check('C10. aiRequests guarda SOLO metadata (context/model/tokens/cost/latency/toolNames/errorCode)',
  !!auditDoc && auditKeys.every((k) => ALLOWED.includes(k)) && auditDoc.model === 'claude-haiku-4-5-20251001' && auditDoc.inputTokens === 1234 && Math.abs(auditDoc.costUsd - estimateCostUsd({ inputTokens: 1234, outputTokens: 567 })) < 1e-9, `keys=${auditKeys.join(',')}`);

// ============================================================================
// 11. Rules de aiRequests: read solo manager+/owner; write solo Admin SDK
// ============================================================================
const seller = await signIn('seller@perfumeria.com');
const owner = await signIn('owner@perfumeria.com');
const sStatus = auditId ? await restGet(seller, `tenants/${T}/aiRequests/${auditId}`) : 0;
const oStatus = auditId ? await restGet(owner, `tenants/${T}/aiRequests/${auditId}`) : 0;
const wStatus = (await fetch(`${FS}/tenants/${T}/aiRequests?documentId=hack-hard-${Date.now()}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` }, body: JSON.stringify({ fields: { status: { stringValue: 'ok' } } }) })).status;
check('C11. rules aiRequests: SELLER read 403, OWNER read 200, escritura de cliente bloqueada',
  sStatus === 403 && oStatus === 200 && wStatus !== 200, `seller=${sStatus} owner=${oStatus} write=${wStatus}`);

// ============================================================================
// 19. Fake client obligatorio en emulador; sin API key → disabled (cero red real)
// ============================================================================
process.env.FUNCTIONS_EMULATOR = 'true';
const emuClient = await getAiClient();
const isFake = emuClient instanceof FakeAiClient;
delete process.env.FUNCTIONS_EMULATOR; // prod sin ANTHROPIC_API_KEY
const prodClient = await getAiClient();
check('C19. cliente IA: emulador → FakeAiClient (cero red); prod sin ANTHROPIC_API_KEY → null (disabled)',
  isFake === true && prodClient === null);

// ---- Limpieza: borrar aiRequests del test, el producto cross-tenant y restaurar stats ----
for (const d of (await db.collection(`tenants/${T}/aiRequests`).where('createdAt', '>=', auditStart).get()).docs) await d.ref.delete().catch(noThrow);
await db.doc(`tenants/${OTHER}/products/${XHARD}`).delete().catch(noThrow);
if (beforePerfStats) await db.doc(`tenants/${T}/stats/private`).set(beforePerfStats); else await db.doc(`tenants/${T}/stats/private`).delete().catch(noThrow);
if (beforeOtherStats) await db.doc(`tenants/${OTHER}/stats/private`).set(beforeOtherStats); else await db.doc(`tenants/${OTHER}/stats/private`).delete().catch(noThrow);

const ok = results.every((x) => x);
console.log(`\nRESULTADO AG-5 (matriz consolidada — todo IA seguro): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
