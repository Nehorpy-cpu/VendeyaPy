/**
 * ai/salesAgent.ts — Sales agent de WhatsApp con Claude Haiku (AG-3)
 * =================================================================
 * Envuelve el gateway con: GATE de entitlements (feature aiAssistant + presupuesto de tokens),
 * tools del contexto `sales` (solo lectura, sanitizadas), y METERING del uso real. Devuelve
 * { used: true, reply } solo si la IA está habilitada Y produjo una respuesta válida; en cualquier
 * otro caso { used: false } y el caller (handleMessage) usa el motor rule-based. Reversible: sin
 * feature/env/presupuesto, la IA nunca corre. El modelo NUNCA recibe datos privados (tools sanitizadas).
 */
import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '@vpw/shared';
import { abrirPresupuestoDeIa } from '../entitlements/ai.js';
import { estimarTurnoDeTexto, type ReservaDeIa } from '../entitlements/aiReservation.js';
import { runAgent } from './gateway.js';
import { buildSalesSystemPrompt } from './prompts.js';
import { toolDefinitionsForContext, executeTool } from './tools/registry.js';
import type { AiMessage, RunAgentInput, RunAgentResult, ToolExecResult } from './types.js';

const SALES_MAX_TOKENS = 700;
/**
 * Rondas máximas del loop de tools del gateway (= DEFAULT_MAX_TOOL_ITERS en ai/gateway.ts, que no
 * se exporta). Si el gateway cambia su tope hay que actualizar acá: la estimación de la reserva
 * cuenta una salida + una re-entrada de resultado de tool por ronda.
 */
const RONDAS_MAX_DE_TOOLS = 4;
/**
 * Tope de productos a recordar en el estado conversacional. Igual al límite del catálogo rule-based
 * (engine.ts catalogo `limit:3`) y al alcance de `ordinalIndex` (primero/segundo/tercero). Así "el
 * primero/segundo/tercero" cubre exactamente lo recordado y no quedan SKUs no seleccionables por orden.
 */
export const MAX_SHOWN_SKUS = 3;
const SHOWN_SKUS_TOOL = 'buscar_productos';

/**
 * Extrae {id, name} de los productos mostrados SOLO del RESULTADO backend de `buscar_productos`
 * (PublicProduct[]). Claude NUNCA aporta SKUs: la fuente de verdad es el array que devolvió la
 * tool server-side (tenant-scoped, sanitizado). Endurecido contra formas raras: ignora no-arrays,
 * items no-objeto, ids no-string/vacíos; deduplica y corta a `max`. El name viaja junto al id
 * para que el motor pueda ALINEAR la respuesta con lo presentado (F3) sin re-leer el catálogo.
 */
export function extractShownProducts(
  toolName: string,
  toolResult: unknown,
  max = MAX_SHOWN_SKUS,
): Array<{ id: string; name: string }> {
  if (toolName !== SHOWN_SKUS_TOOL || !Array.isArray(toolResult)) return [];
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const item of toolResult) {
    if (!item || typeof item !== 'object') continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || !id.trim() || seen.has(id.trim())) continue;
    seen.add(id.trim());
    out.push({ id: id.trim(), name: typeof name === 'string' ? name.trim() : '' });
  }
  return out.slice(0, max);
}

/** Compat: solo los ids (tests/consumidores existentes). */
export function extractShownSkus(toolName: string, toolResult: unknown, max = MAX_SHOWN_SKUS): string[] {
  return extractShownProducts(toolName, toolResult, max).map((p) => p.id);
}

/**
 * AI-FALLBACK-HONESTO-1: razón ESTRUCTURADA del bloqueo (nunca comparar textos de error).
 *  - quota_exhausted: cuota/presupuesto mensual agotado (confirmado por el gate) — único caso
 *    que habilita el handoff automático `ai_unavailable`.
 *  - feature_unavailable: feature apagada / trial vencido / cuenta suspendida.
 *  - configuration_error: sin API key/cliente (gateway 'disabled').
 *  - provider_transient_error: error/timeout del proveedor (transitorio: NO deriva).
 *  - empty_reply: el modelo respondió vacío.
 */
export type SalesAgentBlockReason =
  | 'quota_exhausted'
  | 'feature_unavailable'
  | 'configuration_error'
  | 'provider_transient_error'
  | 'empty_reply';

export type SalesAgentOutcome =
  | {
      used: true;
      reply: string;
      shownSkus: string[];
      /** F3: id+name en el orden de la tool (para alinear con el texto presentado). */
      shownProducts: Array<{ id: string; name: string }>;
      usedTools: string[];
    }
  | { used: false; reason: SalesAgentBlockReason };

export interface SalesAgentDeps {
  /** ADR-0018: abre el ciclo reserva→liquidación (reemplaza assertBudget + recordUsage). */
  openBudget: (tenantId: string, clave: string, estTokens: number) => Promise<ReservaDeIa>;
  runAgent: (input: RunAgentInput) => Promise<RunAgentResult>;
  execTool: (tenantId: string, name: string, input: Record<string, unknown>) => Promise<ToolExecResult>;
}
const defaultDeps: SalesAgentDeps = {
  openBudget: (t, clave, est) => abrirPresupuestoDeIa(t, clave, est, 'whatsapp_sales_agent'),
  runAgent,
  execTool: (t, name, input) => executeTool('whatsapp_sales_agent', t, name, input),
};

/** Chars del contenido TEXTUAL de los mensajes (defensivo: si el content es de bloques, suman solo los `text`). */
const charsDeMensajes = (messages: AiMessage[]): number =>
  messages.reduce((total, m) => {
    if (typeof m.content === 'string') return total + m.content.length;
    if (!Array.isArray(m.content)) return total;
    return total + m.content.reduce((t, b) => (b?.type === 'text' && typeof b.text === 'string' ? t + b.text.length : t), 0);
  }, 0);

export async function runSalesAgent(
  input: { tenantId: string; agentConfig: AgentConfig; messages: AiMessage[]; billingKey?: string | null },
  deps: SalesAgentDeps = defaultDeps,
): Promise<SalesAgentOutcome> {
  // Hito D (AI-PHASE2-MATCHER-AND-RESERVATION-HARDENING-1): system y tools se construyen UNA vez,
  // ANTES de abrir el presupuesto, para derivar la estimación del contexto REAL del turno (prompt +
  // historial + tools + rondas) en vez de la estática 1500 que quedó corta en producción (3.770).
  const system = buildSalesSystemPrompt({ agent: input.agentConfig });
  const tools = toolDefinitionsForContext('whatsapp_sales_agent'); // solo buscar_productos / listar_promociones_activas
  const estimacion = estimarTurnoDeTexto({
    charsSistema: system.length,
    charsMensajes: charsDeMensajes(input.messages),
    charsTools: JSON.stringify(tools).length,
    maxTokensSalida: SALES_MAX_TOKENS,
    rondasDeTools: RONDAS_MAX_DE_TOOLS,
  });

  // GATE (ADR-0018): feature aiAssistant + RESERVA transaccional del presupuesto. La clave
  // lógica viene del caller (`ventas-{wamid}`: los reintentos del webhook comparten reserva);
  // sin clave natural (simulador/dev) se genera una efímera. Si no pasa → fallback con razón
  // ESTRUCTURADA por código de error (HttpsError.code), jamás por texto:
  //  - 'resource-exhausted'  → cuota/presupuesto agotado (habilita el fallback honesto).
  //  - 'failed-precondition' → feature off / trial vencido / suspensión.
  let reserva: ReservaDeIa;
  try {
    const clave = input.billingKey ?? `ventas-${randomUUID()}`;
    reserva = await deps.openBudget(input.tenantId, clave, estimacion);
  } catch (e) {
    const code = (e as { code?: string }).code;
    const reason: SalesAgentBlockReason =
      code === 'resource-exhausted' ? 'quota_exhausted'
      : code === 'failed-precondition' ? 'feature_unavailable'
      // Sin código conocido (Firestore caído, error de infraestructura): transitorio — jamás
      // se interpreta como cuota agotada ni como feature apagada (review).
      : 'provider_transient_error';
    return { used: false, reason };
  }
  // Clave ya facturada por una entrega anterior (reserva cerrada): NO volver a llamar al
  // proveedor — el dedupe upstream (claim del inbox) hace de esto un caso excepcional.
  if (reserva.cerrada) return { used: false, reason: 'provider_transient_error' };

  // Metadata SEGURA capturada server-side durante el loop de tools (no del texto del modelo).
  let shownProducts: Array<{ id: string; name: string }> = [];
  const usedTools: string[] = [];

  const result = await deps.runAgent({
    tenantId: input.tenantId,
    context: 'whatsapp_sales_agent',
    system, // el MISMO system/tools sobre el que se estimó la reserva (construidos una vez, arriba)
    messages: input.messages,
    tools,
    maxTokens: SALES_MAX_TOKENS,
    executeTool: async (name, toolInput) => {
      usedTools.push(name);
      const r = await deps.execTool(input.tenantId, name, toolInput); // tenantId del contexto, no del modelo
      // Productos mostrados = SOLO del resultado backend de buscar_productos (la última búsqueda no vacía gana).
      if (r.ok) {
        const shown = extractShownProducts(name, r.result);
        if (shown.length) shownProducts = shown;
      }
      return r.ok ? r.result : { error: r.error };
    },
  });

  // disabled (sin API key/cliente) / error (Claude falló) / texto vacío o inválido → fallback rule-based.
  if (result.status !== 'ok' || !result.reply || !result.reply.trim()) {
    const reason: SalesAgentBlockReason =
      result.status === 'ok' ? 'empty_reply'
      : result.status === 'disabled' ? 'configuration_error'
      : 'provider_transient_error';
    // Cierre de la reserva según lo que REALMENTE pasó (ADR-0018): 'disabled' = el proveedor
    // jamás fue contactado → liberar completo; 'error'/vacío = pudo haber consumo parcial (el
    // gateway lo acumula y lo devuelve) → liquidar lo real. Nunca rompe la respuesta.
    try {
      if (result.status === 'disabled') await reserva.liberar('proveedor_no_configurado');
      else await reserva.liquidar(result.usage ?? { inputTokens: 0, outputTokens: 0 }, result.costUsd ?? 0);
    } catch { /* el cierre del presupuesto nunca rompe el fallback */ }
    return { used: false, reason };
  }

  // LIQUIDAR: uso real (tokens + costo) exactamente una vez. No bloquea la respuesta si falla
  // (la reserva queda recuperable por vencimiento; jamás doble cobro).
  try {
    await reserva.liquidar(result.usage ?? { inputTokens: 0, outputTokens: 0 }, result.costUsd ?? 0);
  } catch {
    /* el metering nunca debe romper la respuesta al cliente */
  }

  return {
    used: true,
    reply: result.reply.trim(),
    shownSkus: shownProducts.map((p) => p.id),
    shownProducts: [...shownProducts],
    usedTools: [...usedTools],
  };
}
