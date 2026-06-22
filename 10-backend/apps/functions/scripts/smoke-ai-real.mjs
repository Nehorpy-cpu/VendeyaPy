/**
 * smoke-ai-real.mjs — Smoke REAL del AI Gateway contra Anthropic (AI-SMOKE-REAL · MANUAL).
 * =======================================================================================
 * ⚠️ NO corre en `pnpm test` ni en CI. Hace UNA sola llamada real a api.anthropic.com con tokens
 * mínimos (sin tools, sin reintentos en 4xx). La key se lee de `process.env.ANTHROPIC_API_KEY`
 * (NUNCA se imprime ni se commitea). Sin key → NO llama: sale con instrucción para configurarla.
 *
 * Override opcional del modelo SOLO para el smoke: `ANTHROPIC_MODEL` (p.ej. el ID datado
 * `claude-haiku-4-5-20251001`). No cambia el modelo de producción.
 *
 * Verifica (1 llamada, vía runAgent con el cliente REAL inyectado):
 *   - status ok + reply no vacío; usage tokens > 0; costUsd coherente;
 *   - auditoría = SOLO metadata (sin system prompt, sin mensaje del usuario, sin PII);
 *   - FALLBACK sin cliente → 'disabled' (sin red).
 * Si la llamada real FALLA, imprime un DIAGNÓSTICO SEGURO del error de Anthropic: status HTTP, clase,
 * type/code del proveedor, request-id y el mensaje del proveedor RECORTADO. NUNCA imprime la API key,
 * el system prompt, el mensaje del usuario ni el stack.
 *
 * PowerShell (Windows) — ingreso oculto de la key (ver docs/ai-gateway.md §AI-KEY-1):
 *   $sec = Read-Host -AsSecureString "ANTHROPIC_API_KEY"
 *   $env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
 *   node scripts/smoke-ai-real.mjs ;  Remove-Item Env:\ANTHROPIC_API_KEY
 */
import { HttpAnthropicClient } from '../lib/ai/client.js';
import { runAgent } from '../lib/ai/gateway.js';
import { AI_MODEL, estimateCostUsd } from '../lib/ai/pricing.js';

const key = process.env.ANTHROPIC_API_KEY;
if (!key || !key.trim()) {
  console.error('❌ No hay ANTHROPIC_API_KEY en el entorno. NO se hizo ninguna llamada.');
  console.error('   PowerShell (ingreso oculto):');
  console.error('     $sec = Read-Host -AsSecureString "ANTHROPIC_API_KEY"');
  console.error('     $env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))');
  console.error('     node scripts/smoke-ai-real.mjs ;  Remove-Item Env:\\ANTHROPIC_API_KEY');
  process.exitCode = 2; // salida natural (no process.exit) → evita el assert de libuv en Windows
}

/** Extrae SOLO campos seguros de un error de Anthropic. NUNCA toca key/system/user/stack. */
function safeDiag(e) {
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const body = e?.error; // cuerpo del proveedor: { type, error: { type, message, code? } } — sin el request
  const provType = body?.error?.type ?? body?.type;
  const provCode = body?.error?.code;
  const rawMsg = body?.error?.message ?? (typeof body === 'string' ? body : undefined);
  const providerMessage = typeof rawMsg === 'string' ? rawMsg.slice(0, 300) : undefined;
  const h = e?.headers;
  const requestId =
    e?.request_id ?? e?.requestID ??
    (h && typeof h.get === 'function' ? h.get('request-id') ?? h.get('x-request-id') : h?.['request-id'] ?? h?.['x-request-id']);
  return { status, errorClass: e?.name, providerType: provType, providerCode: provCode, requestId, providerMessage };
}

async function runSmoke(apiKey) {
  const model = process.env.ANTHROPIC_MODEL?.trim() || AI_MODEL;
  const results = [];
  const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };

  const SYS = 'Respondé únicamente con la palabra: ok';
  const MSG = 'decí ok';

  // Cliente REAL envuelto: aplica el override de modelo y CAPTURA el error crudo (para diagnóstico
  // seguro) sin que el gateway lo exponga. runAgent hace exactamente 1 createMessage (sin tools).
  const real = new HttpAnthropicClient(apiKey);
  let rawError = null;
  const diagClient = {
    async createMessage(p) {
      try { return await real.createMessage({ ...p, model }); }
      catch (e) { rawError = e; throw e; }
    },
  };
  const audits = [];
  const deps = { getClient: async () => diagClient, writeAudit: async (r) => { audits.push(r); }, now: () => Date.now() };

  console.log(`→ 1 llamada REAL a Anthropic (modelo: ${model}, maxTokens: 32)…`);
  const res = await runAgent(
    { tenantId: 'smoke-demo', context: 'whatsapp_sales_agent', system: SYS, messages: [{ role: 'user', content: MSG }], maxTokens: 32 },
    deps,
  );

  if (res.status !== 'ok') {
    const d = rawError ? safeDiag(rawError) : { status: res.errorCode };
    console.error('\n❌ La llamada real a Anthropic FALLÓ. Diagnóstico SEGURO (sin key / prompt / PII / stack):');
    console.error(`   status HTTP:      ${d.status ?? '—'}`);
    console.error(`   error class:      ${d.errorClass ?? '—'}`);
    console.error(`   provider type:    ${d.providerType ?? '—'}`);
    console.error(`   provider code:    ${d.providerCode ?? '—'}`);
    console.error(`   request id:       ${d.requestId ?? '—'}`);
    console.error(`   provider message: ${d.providerMessage ?? '—'}`);
    console.error(`   modelo usado:     ${model}`);
    const pm = (d.providerMessage ?? '').toLowerCase();
    if (d.status === 400 && /(credit|balance|too low|billing|purchase|insufficient)/.test(pm)) {
      console.error('   → PROBABLE: saldo/créditos de Anthropic. Revisá Plans & Billing en console.anthropic.com.');
    } else if (d.status === 404 || /model/.test(pm)) {
      console.error('   → PROBABLE: modelo no habilitado para la cuenta. Reintentá con ANTHROPIC_MODEL=claude-haiku-4-5-20251001.');
    } else if (d.status === 401 || d.status === 403) {
      console.error('   → PROBABLE: API key inválida o sin permisos. Verificá la key/permiso en la consola.');
    } else if (d.status === 429) {
      console.error('   → PROBABLE: rate limit. Reintentá más tarde (NO en bucle).');
    }
    console.error('\n   (1 sola llamada hecha. NO reintentar en bucle.)');
    process.exitCode = 1;
    return;
  }

  // --- Éxito: la conexión real funciona ---
  check('1. La llamada real responde status ok + reply no vacío', typeof res.reply === 'string' && res.reply.trim().length > 0);
  check('2. usage real: inputTokens y outputTokens > 0', (res.usage?.inputTokens ?? 0) > 0 && (res.usage?.outputTokens ?? 0) > 0, JSON.stringify(res.usage));
  check('3. costUsd coherente con el pricing (Haiku)', typeof res.costUsd === 'number' && res.costUsd > 0 && Math.abs(res.costUsd - estimateCostUsd(res.usage)) < 1e-9, `costUsd=${res.costUsd}`);

  const rec = audits[0];
  const auditKeys = rec ? Object.keys(rec) : [];
  const ALLOWED = ['tenantId', 'context', 'model', 'status', 'latencyMs', 'inputTokens', 'outputTokens', 'costUsd', 'toolNames', 'errorCode'];
  const recJson = rec ? JSON.stringify(rec) : '';
  check('4. auditoría = SOLO metadata (tokens/costo/latencia/context)', !!rec && auditKeys.every((k) => ALLOWED.includes(k)) && rec.inputTokens > 0 && rec.costUsd > 0, `keys=${auditKeys.join(',')}`);
  check('5. auditoría NO guarda system prompt / mensaje del usuario / PII', !!rec && !recJson.includes(SYS) && !recJson.includes(MSG));

  // FALLBACK: sin cliente (key removida) → disabled, sin red, sin lanzar.
  const fb = await runAgent(
    { tenantId: 'smoke-demo', context: 'whatsapp_sales_agent', system: SYS, messages: [{ role: 'user', content: MSG }], maxTokens: 32 },
    { getClient: async () => null, writeAudit: async () => {}, now: () => Date.now() },
  );
  check('6. FALLBACK: sin key → status disabled (no rompe; el caller usa rule-based / error controlado)', fb.status === 'disabled');

  const ok = results.every((x) => x);
  console.log(`\nRESULTADO AI-SMOKE-REAL: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
  console.log(`(reply de muestra: "${(res.reply ?? '').slice(0, 40)}")`);
  process.exitCode = ok ? 0 : 1;
}

if (key && key.trim()) {
  await runSmoke(key); // salida natural: setea process.exitCode adentro, sin process.exit()
}
