/**
 * smoke-ai-real.mjs — Smoke REAL del AI Gateway contra Anthropic (AI-SMOKE-REAL · MANUAL).
 * =======================================================================================
 * ⚠️ NO corre en `pnpm test` ni en CI. Hace UNA sola llamada real a api.anthropic.com con tokens
 * mínimos. La key se lee de `process.env.ANTHROPIC_API_KEY` (NUNCA se imprime ni se commitea). Si no
 * está la key, NO llama: sale con instrucción para configurarla.
 *
 * Verifica end-to-end con el cliente REAL (HttpAnthropicClient inyectado, sin emulador):
 *   - status 'ok' + reply no vacío (la conexión real funciona);
 *   - usage.inputTokens/outputTokens > 0 y costUsd coherente (metering real);
 *   - el registro de auditoría (lo que persiste writeAiRequest) trae SOLO metadata: model/tokens/
 *     costo/latencia/context — sin system prompt, sin mensaje del usuario, sin PII;
 *   - FALLBACK: sin cliente (key removida) → status 'disabled' (el bot/callable no se rompe).
 *
 * Uso (ver docs/ai-gateway.md §AI-KEY-1 para ingresar la key de forma segura):
 *   ANTHROPIC_API_KEY=… node scripts/smoke-ai-real.mjs      (o exportala antes en la shell)
 */
import { HttpAnthropicClient } from '../lib/ai/client.js';
import { runAgent } from '../lib/ai/gateway.js';
import { estimateCostUsd } from '../lib/ai/pricing.js';

const key = process.env.ANTHROPIC_API_KEY;
if (!key || !key.trim()) {
  console.error('❌ No hay ANTHROPIC_API_KEY en el entorno. NO se hizo ninguna llamada.');
  console.error('   Configurala de forma segura (sin mostrarla) y reintentá:');
  console.error('     bash:  read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY && node scripts/smoke-ai-real.mjs');
  process.exit(2);
}

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };

const audits = [];
const realDeps = { getClient: async () => new HttpAnthropicClient(key), writeAudit: async (r) => { audits.push(r); }, now: () => Date.now() };

const SYS = 'Respondé únicamente con la palabra: ok';
const MSG = 'decí ok';
console.log('→ 1 llamada REAL a Anthropic (tokens mínimos)…');
const res = await runAgent(
  { tenantId: 'smoke-demo', context: 'whatsapp_sales_agent', system: SYS, messages: [{ role: 'user', content: MSG }], maxTokens: 16 },
  realDeps,
);

check('1. La llamada real responde status ok + reply no vacío', res.status === 'ok' && typeof res.reply === 'string' && res.reply.trim().length > 0, `status=${res.status}`);
check('2. usage real: inputTokens y outputTokens > 0', (res.usage?.inputTokens ?? 0) > 0 && (res.usage?.outputTokens ?? 0) > 0, JSON.stringify(res.usage));
check('3. costUsd coherente con el pricing (Haiku)', typeof res.costUsd === 'number' && res.costUsd > 0 && Math.abs(res.costUsd - estimateCostUsd(res.usage)) < 1e-9, `costUsd=${res.costUsd}`);

const rec = audits[0];
const keys = rec ? Object.keys(rec) : [];
const ALLOWED = ['tenantId', 'context', 'model', 'status', 'latencyMs', 'inputTokens', 'outputTokens', 'costUsd', 'toolNames', 'errorCode'];
const recJson = rec ? JSON.stringify(rec) : '';
check('4. auditoría = SOLO metadata (model/tokens/costo/latencia/context)', !!rec && keys.every((k) => ALLOWED.includes(k)) && rec.model === 'claude-haiku-4-5' && rec.inputTokens > 0 && rec.costUsd > 0, `keys=${keys.join(',')}`);
check('5. auditoría NO guarda system prompt / mensaje del usuario / PII', !!rec && !recJson.includes(SYS) && !recJson.includes(MSG));

// FALLBACK: sin cliente (key removida) → disabled, sin lanzar.
const fb = await runAgent(
  { tenantId: 'smoke-demo', context: 'whatsapp_sales_agent', system: SYS, messages: [{ role: 'user', content: MSG }], maxTokens: 16 },
  { getClient: async () => null, writeAudit: async () => {}, now: () => Date.now() },
);
check('6. FALLBACK: sin key → status disabled (no rompe; el caller usa rule-based / error controlado)', fb.status === 'disabled');

const ok = results.every((x) => x);
console.log(`\nRESULTADO AI-SMOKE-REAL: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
console.log(`(reply de muestra: "${(res.reply ?? '').slice(0, 40)}")`);
process.exit(ok ? 0 : 1);
