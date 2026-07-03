import { describe, it, expect } from 'vitest';
import { buildSalesSystemPrompt } from './prompts.js';
import type { AgentConfig } from '@vpw/shared';

const agent = { agentName: 'Sofía', businessName: 'Arfagi', tone: 'amable', faq: [] } as unknown as AgentConfig;

/**
 * F2 (CART-INTENT-SAFETY): la IA es ADVISORY — no puede escribir carrito/pedidos/pagos.
 * El smoke de prod la agarró diciendo "agregué el producto" y pidiendo dirección/teléfono sin
 * haber ejecutado nada. Estos tests fijan que la prohibición esté SIEMPRE en el system prompt.
 */
describe('ai/prompts buildSalesSystemPrompt — prohibición de acciones (F2)', () => {
  const prompt = buildSalesSystemPrompt({ agent });

  it('prohíbe afirmar acciones que no puede ejecutar', () => {
    expect(prompt).toContain('NO podés ejecutar acciones');
    expect(prompt).toContain('NUNCA digas "agregué"');
  });

  it('prohíbe pedir datos de envío/pago y deriva al flujo del sistema', () => {
    expect(prompt).toContain('ni pidas nombre/dirección/teléfono/datos de pago');
    expect(prompt).toContain('*pagar*');
  });

  it('mantiene las reglas consultivas de F1B (producto encontrado → concreto)', () => {
    expect(prompt).toContain('respondé CONCRETO');
    expect(prompt).toContain('consulta');
  });
});
