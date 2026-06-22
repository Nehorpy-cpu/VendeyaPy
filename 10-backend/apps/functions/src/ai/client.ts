/**
 * ai/client.ts — Cliente de Claude inyectable (AG-1)
 * ==================================================
 * En PRODUCCIÓN: HttpAnthropicClient (SDK oficial @anthropic-ai/sdk) con la API key del backend.
 * En EMULADOR/TESTS: FakeAiClient (respuestas canned desde `aiTestFixtures/ai`) — NUNCA llama a
 * api.anthropic.com. Sin API key en prod → getAiClient() devuelve null (estado disabled, sin crash).
 * La API key vive SOLO en el backend (env ANTHROPIC_API_KEY); nunca se loguea ni va al frontend.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../lib/firebase.js';
import type { AiClient, AiResponse, AiToolUse, CreateMessageParams } from './types.js';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2; // el SDK reintenta 429/5xx con backoff.

/** Cliente real: POST a la Messages API de Anthropic. El token NUNCA se loguea. */
export class HttpAnthropicClient implements AiClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: MAX_RETRIES, timeout: REQUEST_TIMEOUT_MS });
  }

  async createMessage(params: CreateMessageParams): Promise<AiResponse> {
    const res = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(params.tools && params.tools.length
        ? { tools: params.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
        : {}),
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolUses: AiToolUse[] = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));

    return {
      text,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      stopReason: res.stop_reason ?? undefined,
      toolUses,
    };
  }
}

/** Fixture del fake (emulador/tests). Permite simular ok, fallo y usage. */
export interface AiFixture {
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  fail?: boolean;
  failMessage?: string;
  toolUses?: AiToolUse[];
}

/** Cliente fake: no toca la red. Devuelve lo del fixture (o un default) o lanza si fail. */
export class FakeAiClient implements AiClient {
  constructor(private readonly fx: AiFixture = {}) {}

  async createMessage(_params: CreateMessageParams): Promise<AiResponse> {
    if (this.fx.fail) throw new Error(this.fx.failMessage ?? 'fixture: el cliente de IA falló');
    return {
      text: this.fx.text ?? 'respuesta fake del agente',
      usage: { inputTokens: this.fx.inputTokens ?? 10, outputTokens: this.fx.outputTokens ?? 20 },
      stopReason: 'end_turn',
      toolUses: this.fx.toolUses ?? [],
    };
  }
}

const isEmulator = (): boolean => process.env.FUNCTIONS_EMULATOR === 'true';

/**
 * Cliente activo. En emulador SIEMPRE fake (lee el fixture de Firestore). En prod, real si hay
 * ANTHROPIC_API_KEY; si falta, null → el gateway responde `disabled` (sin crashear).
 */
export async function getAiClient(): Promise<AiClient | null> {
  if (isEmulator()) {
    const fx = (await db().doc('aiTestFixtures/ai').get()).data() as AiFixture | undefined;
    return new FakeAiClient(fx ?? {});
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new HttpAnthropicClient(apiKey);
}
