/**
 * ai/types.ts — Tipos del AI Gateway (Claude Haiku · AG-1)
 * ========================================================
 * Contratos del gateway backend. El frontend NUNCA llama a Claude; el gateway recibe el
 * `tenantId` YA resuelto por el backend (auth/webhook) y Claude no lee Firestore directo:
 * solo se le pasan `system`/`messages`/`tools` que arma el backend.
 */

/** Contextos separados desde el inicio (data policy + prompts distintos en AG-2/AG-3). */
export type AiContext = 'whatsapp_sales_agent' | 'internal_growth_assistant';

/** Bloques de contenido (para round-trips de tool-use). El texto plano sigue siendo válido. */
export interface AiTextBlock {
  type: 'text';
  text: string;
}
export interface AiToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface AiToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
}
export type AiContentBlock = AiTextBlock | AiToolUseBlock | AiToolResultBlock;

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string | AiContentBlock[];
}

export interface AiToolSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  // Index signature: compatibilidad con el `input_schema` del SDK de Anthropic (Tool.InputSchema).
  [k: string]: unknown;
}

/** Definición de herramienta para el modelo. La EJECUCIÓN es server-side (AG-2/AG-3). */
export interface AiTool {
  name: string;
  description: string;
  inputSchema: AiToolSchema;
}

/** Pedido de uso de herramienta que devuelve el modelo (lo ejecuta el backend, no el modelo). */
export interface AiToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiResponse {
  text: string;
  usage: AiUsage;
  stopReason?: string;
  toolUses: AiToolUse[];
}

export interface CreateMessageParams {
  model: string;
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  tools?: AiTool[];
}

/** Cliente inyectable: real (Anthropic) en prod, fake (fixtures) en emulador/tests. */
export interface AiClient {
  createMessage(params: CreateMessageParams): Promise<AiResponse>;
}

export type AiStatus = 'ok' | 'error' | 'disabled';

export interface RunAgentInput {
  /** Resuelto por el backend (auth/webhook). NUNCA viene del input del cliente. */
  tenantId: string;
  context: AiContext;
  system: string;
  messages: AiMessage[];
  tools?: AiTool[];
  maxTokens?: number;
  /** Ejecutor server-side de tools (tenant-scoped). Sin él, no hay loop de tool-use. */
  executeTool?: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  /** Máximo de rondas de tool-use antes de cerrar con texto (default 4). */
  maxToolIters?: number;
}

export interface RunAgentResult {
  status: AiStatus;
  model: string;
  latencyMs: number;
  reply?: string;
  usage?: AiUsage;
  costUsd?: number;
  toolUses?: AiToolUse[];
  /** Código seguro (sin cuerpo del error ni datos sensibles). */
  errorCode?: string;
}

/** Registro de auditoría (sin prompts/PII): solo metadatos. */
export interface AiAuditRecord {
  tenantId: string;
  context: AiContext;
  model: string;
  status: AiStatus;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  toolNames?: string[];
  errorCode?: string;
}

/** Dependencias inyectables (para tests sin red ni Firestore). */
export interface RunAgentDeps {
  getClient: () => Promise<AiClient | null>;
  writeAudit: (record: AiAuditRecord) => Promise<void>;
  now: () => number;
}

/**
 * Herramienta server-side (AG-2). `execute` recibe el `tenantId` YA RESUELTO por el backend y
 * lo usa para la query; IGNORA por completo cualquier tenantId que venga en `input` (del modelo o
 * del cliente). En esta fase todas las tools son READ-ONLY (sin writes ni acciones críticas).
 */
export interface AiToolHandler {
  definition: AiTool;
  execute(tenantId: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface ToolExecResult {
  ok: boolean;
  result?: unknown;
  /** Mensaje seguro (sin datos sensibles) cuando la tool no está permitida o falla. */
  error?: string;
}
