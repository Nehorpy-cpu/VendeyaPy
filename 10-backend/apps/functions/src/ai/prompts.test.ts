import { describe, it, expect } from 'vitest';
import { buildSalesSystemPrompt } from './prompts.js';
import type { AgentConfig } from '@vpw/shared';

const agent = { agentName: 'Sofía', businessName: 'Arfagi', tone: 'amable', faq: [] } as unknown as AgentConfig;

/**
 * F2 (CART-INTENT-SAFETY) + F3 (CART-TARGETING): la IA es ADVISORY — no puede escribir
 * carrito/pedidos/pagos, no promete acciones y NO le enseña comandos al cliente. El live smoke
 * la agarró diciendo "escribí bien el comando para que el sistema lo procese" — el prompt viejo
 * literalmente le indicaba dictar frases. Estos tests fijan la conducta.
 */
describe('ai/prompts buildSalesSystemPrompt — prohibición de acciones (F2) y de comandos (F3)', () => {
  const prompt = buildSalesSystemPrompt({ agent });

  it('prohíbe afirmar acciones que no puede ejecutar', () => {
    expect(prompt).toContain('NO podés ejecutar acciones');
    expect(prompt).toContain('NUNCA digas "agregué"');
    expect(prompt).toContain('"ya lo agregué"');
    expect(prompt).toContain('"creé tu pedido"');
  });

  it('prohíbe pedir datos de envío/pago', () => {
    expect(prompt).toContain('no pidas nombre/dirección/teléfono/datos de pago');
  });

  it('F4: prohíbe afirmar/describir estado del carrito y responde reclamos con honestidad', () => {
    expect(prompt).toContain('"ya está en tu carrito"');
    expect(prompt).toContain('"pedido confirmado"');
    expect(prompt).toContain('Tampoco AFIRMES ni describas el contenido del carrito');
    expect(prompt).toContain('Si el cliente RECLAMA');
    expect(prompt).toContain('NUNCA respondas que ya está hecho');
    expect(prompt).toContain('Tenés razón, revisemos');
  });

  it('F3: prohíbe dictar comandos/frases exactas y mencionar "el sistema"', () => {
    expect(prompt).toContain('NO tiene que aprender comandos');
    expect(prompt).toContain('NUNCA le pidas que escriba una palabra exacta');
    expect(prompt).toContain('no menciones "el sistema"');
  });

  it('F3: pide cierres naturales de venta', () => {
    expect(prompt).toContain('¿Querés que te lo agregue?');
    expect(prompt).toContain('Decime cuál preferís y lo agrego');
  });

  it('F3: ya NO instruye dictar palabras clave (regresión del prompt viejo)', () => {
    expect(prompt).not.toContain('indicale que responda');
    expect(prompt).not.toContain('que escriba *pagar*');
    expect(prompt).not.toContain('"agregá + nombre"');
  });

  it('mantiene la numeración alineada con buscar_productos y solo lo recomendado', () => {
    expect(prompt).toContain('lista NUMERADA');
    expect(prompt).toContain('MISMO orden en que los devolvió buscar_productos');
    expect(prompt).toContain('SOLO los que realmente recomendás');
  });

  it('mantiene las reglas consultivas de F1B (producto encontrado → concreto)', () => {
    expect(prompt).toContain('respondé CONCRETO');
    expect(prompt).toContain('consulta');
  });
});
