/**
 * ai/tools/registry.ts — Allowlist de tools por contexto (AG-2)
 * ============================================================
 * Mapea cada AiContext a SU set de tools. El sales agent NO puede llamar tools internas y viceversa
 * (si pide una tool fuera de su allowlist → not-found, no se ejecuta). `executeTool` corre la tool
 * con el `tenantId` del CONTEXTO (resuelto por el backend); el `input` del modelo nunca cambia el tenant.
 * En AG-2 todas las tools son READ-ONLY (sin writes ni acciones críticas).
 */
import type { AiContext, AiTool, AiToolHandler, ToolExecResult } from '../types.js';
import { buscarProductos, listarPromocionesActivas } from './salesTools.js';
import { resumenVentas } from './internalTools.js';

const SALES_TOOLS: AiToolHandler[] = [buscarProductos, listarPromocionesActivas];
const INTERNAL_TOOLS: AiToolHandler[] = [resumenVentas];

export function toolsForContext(context: AiContext): AiToolHandler[] {
  return context === 'whatsapp_sales_agent' ? SALES_TOOLS : INTERNAL_TOOLS;
}

/** Definiciones (lo que ve el modelo) del contexto. Nunca incluye tools de otro contexto. */
export function toolDefinitionsForContext(context: AiContext): AiTool[] {
  return toolsForContext(context).map((t) => t.definition);
}

/**
 * Ejecuta una tool pedida por el modelo. `tenantId` es el del contexto (no del input). Si la tool no
 * está en el allowlist del contexto → ok:false (no se ejecuta). Nunca lanza: error → mensaje seguro.
 */
export async function executeTool(
  context: AiContext,
  tenantId: string,
  name: string,
  input: Record<string, unknown> = {},
): Promise<ToolExecResult> {
  const tool = toolsForContext(context).find((t) => t.definition.name === name);
  if (!tool) return { ok: false, error: `Herramienta '${name}' no disponible en el contexto ${context}.` };
  try {
    const result = await tool.execute(tenantId, input);
    return { ok: true, result };
  } catch {
    return { ok: false, error: 'La herramienta no pudo completarse.' };
  }
}
