/**
 * ai/types.ts — Tipos del AI Gateway (Claude Haiku · AG-1)
 * ========================================================
 * Contratos del gateway backend. El frontend NUNCA llama a Claude; el gateway recibe el
 * `tenantId` YA resuelto por el backend (auth/webhook) y Claude no lee Firestore directo:
 * solo se le pasan `system`/`messages`/`tools` que arma el backend.
 */

/** Contextos separados desde el inicio (data policy + prompts distintos en AG-2/AG-3). */
export type AiContext = 'whatsapp_sales_agent' | 'internal_growth_assistant';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
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
