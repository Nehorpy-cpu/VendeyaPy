/**
 * review-window-audit.mjs — Actividad inbound REAL por número (READ-ONLY, cero mutación).
 * =========================================================================================
 * Responde dos preguntas del programa APP-REVIEW-STATUS-AND-DEPLOY-WINDOW-1:
 *   1. ¿Meta está probando activamente el número de App Review? (último inbound, distribución
 *      de 30 días, actividad 7d/48h del tenant que rutea ese número)
 *   2. ¿Cuál es la ventana de menor tráfico para desplegar? (distribución por hora y día de
 *      semana, America/Asuncion, del tenant real)
 *
 * CÓMO LEE, y por qué así:
 *   - Patrón sin gcloud de HANDOFF §5 (requireAuth + apiv2.Client contra la API REST), el mismo
 *     de release-audit.mjs. Solo GET.
 *   - PNID → tenant por `metaExternalIndex/whatsapp_{pnid}` (jamás se adivina un tenantId).
 *   - Mensajes por enumeración de las subcolecciones `messages` de cada cliente con **field mask**
 *     (`direction,createdAt,receivedVia`): el TEXTO de los mensajes NI SIQUIERA viaja en la
 *     respuesta. Cero contenido, solo timestamps y conteos.
 *   - Sin índices nuevos: la alternativa (collectionGroup con 3 filtros) exigiría un índice
 *     compuesto que prod no tiene; enumerar es más lento pero read-only puro.
 *
 * PRIVACIDAD: teléfonos SIEMPRE enmascarados (`…últimos3`); el informe imprime conteos y
 * horas, jamás un número entero ni un texto.
 *
 * LÍMITE DECLARADO DEL DATO: el backend no puede distinguir «inbound de un revisor de Meta» de
 * «inbound del owner probando» — se reporta el conteo de remitentes distintos y las fechas, y
 * la interpretación queda escrita como interpretación.
 *
 * USO:  node scripts/review-window-audit.mjs --project vpw-prod-dd6ff [--dias 30] [--json]
 * EXIT: 0 lectura completa · 1 no se pudieron resolver los dos números esperados · 2 uso.
 */
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const RAIZ_FT = `${(process.env.APPDATA ?? '').replace(/\\/g, '/')}/npm/node_modules/firebase-tools`;

const arg = (n, def = '') => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? (process.argv[i + 1] ?? '') : '';
  return v && !v.startsWith('--') ? v : def;
};
const PROJECT = arg('project');
const DIAS = Number(arg('dias', '30'));
if (!PROJECT) {
  console.log('uso: node scripts/review-window-audit.mjs --project <projectId> [--dias 30] [--json]');
  process.exit(2);
}

/** Un teléfono JAMÁS se imprime entero (misma convención que release-audit.mjs). */
const mask = (s) => `…${String(s ?? '').slice(-3)}`;

const { requireAuth } = req(`${RAIZ_FT}/lib/requireAuth`);
const { Client } = req(`${RAIZ_FT}/lib/apiv2`);
const auth = req(`${RAIZ_FT}/lib/auth`);
await requireAuth({ project: PROJECT, projectId: PROJECT, ...(auth.getProjectDefaultAccount() ?? {}) });
const client = new Client({ urlPrefix: 'https://firestore.googleapis.com', apiVersion: 'v1' });
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;

/**
 * Lista TODOS los documentos de una colección, paginado, con field mask opcional.
 * El mask va como parámetro REPETIDO en la URL (`mask.fieldPaths=a&mask.fieldPaths=b`):
 * así la respuesta trae SOLO esos campos y el texto de los mensajes ni siquiera viaja.
 */
async function listar(ruta, campos = null) {
  const out = [];
  let pageToken = '';
  const maskQS = campos ? campos.map((c) => `&mask.fieldPaths=${encodeURIComponent(c)}`).join('') : '';
  do {
    const tokenQS = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const r = await client.get(`/${DOCS}/${ruta}?pageSize=300${maskQS}${tokenQS}`);
    out.push(...(r.body?.documents ?? []));
    pageToken = r.body?.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

// ── 1. PNIDs que rutean, por el índice (cero supuestos de tenantId) ─────────────────────────
const idx = await listar('metaExternalIndex');
const numeros = idx
  .filter((d) => String(d.name).split('/').pop().startsWith('whatsapp_'))
  .map((d) => ({
    pnid: String(d.name).split('/').pop().slice('whatsapp_'.length),
    tenantId: d.fields?.tenantId?.stringValue ?? null,
  }))
  .filter((n) => n.tenantId);
if (numeros.length < 2) {
  console.error(`BLOQUEADO: se esperaban ≥2 números ruteados en metaExternalIndex y hay ${numeros.length}.`);
  process.exit(1);
}

// ── 2. Actividad por tenant (enumeración con field mask; el texto jamás viaja) ──────────────
const desde = Date.now() - DIAS * 24 * 3600 * 1000;
const fmtHora = new Intl.DateTimeFormat('es-PY', { timeZone: 'America/Asuncion', hour: '2-digit', hour12: false });
const fmtDia = new Intl.DateTimeFormat('es-PY', { timeZone: 'America/Asuncion', weekday: 'short' });
const fmtFecha = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' });

async function actividadDe(tenantId) {
  const clientes = await listar(`tenants/${tenantId}/customers`, ['updatedAt']);
  let totalMsgs = 0;
  const inbound = [];
  for (const c of clientes) {
    const cid = String(c.name).split('/').pop();
    const msgs = await listar(`tenants/${tenantId}/customers/${cid}/messages`, ['direction', 'createdAt', 'receivedVia']);
    totalMsgs += msgs.length;
    for (const m of msgs) {
      if (m.fields?.direction?.stringValue !== 'in') continue;
      const ts = m.fields?.createdAt?.timestampValue;
      if (!ts) continue;
      inbound.push({ t: new Date(ts).getTime(), via: m.fields?.receivedVia?.stringValue ?? null, de: cid });
    }
  }
  inbound.sort((a, b) => a.t - b.t);
  const enVentana = inbound.filter((m) => m.t >= desde);
  const ahora = Date.now();
  const porDia = {};
  const porHora = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h).padStart(2, '0'), 0]));
  const porHoraYDiaSemana = {};
  for (const m of enVentana) {
    const d = new Date(m.t);
    const dia = fmtFecha.format(d);
    const hora = fmtHora.format(d).padStart(2, '0');
    const diaSem = fmtDia.format(d);
    porDia[dia] = (porDia[dia] ?? 0) + 1;
    porHora[hora] = (porHora[hora] ?? 0) + 1;
    porHoraYDiaSemana[diaSem] = porHoraYDiaSemana[diaSem] ?? {};
    porHoraYDiaSemana[diaSem][hora] = (porHoraYDiaSemana[diaSem][hora] ?? 0) + 1;
  }
  const ultimo = inbound.at(-1) ?? null;
  return {
    tenantId,
    clientes: clientes.length,
    mensajesLeidos: totalMsgs,
    inboundTotalHistorico: inbound.length,
    inboundEnVentana: enVentana.length,
    remitentesDistintosEnVentana: new Set(enVentana.map((m) => m.de)).size,
    remitentesEnVentanaEnmascarados: [...new Set(enVentana.map((m) => mask(m.de)))],
    ultimoInbound: ultimo ? { fechaISO: new Date(ultimo.t).toISOString(), via: mask(ultimo.via), hace_horas: Math.round((ahora - ultimo.t) / 36e5) } : null,
    ultimos7d: inbound.filter((m) => m.t >= ahora - 7 * 24 * 36e5).length,
    ultimas48h: inbound.filter((m) => m.t >= ahora - 48 * 36e5).length,
    porDia,
    porHora,
    porHoraYDiaSemana,
  };
}

const resultado = { proyecto: PROJECT, ventanaDias: DIAS, generado: new Date().toISOString(), tenants: {} };
for (const n of numeros) {
  resultado.tenants[mask(n.pnid)] = await actividadDe(n.tenantId);
}

console.log(JSON.stringify(resultado, null, 1));
process.exit(0);
