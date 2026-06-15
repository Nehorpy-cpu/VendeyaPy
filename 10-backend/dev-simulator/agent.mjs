/**
 * agent.mjs — El agente de ventas (orquestador)
 * ==============================================
 * Corre el loop de tool-calling, idéntico al "manual agentic loop" de Claude:
 *   1. pensar (brain.respond)
 *   2. si pide tools → ejecutarlas → devolver resultados → repetir
 *   3. si responde texto → enviar por WhatsApp y terminar
 *
 * El agente NO sabe si el cerebro es mock o Claude real. Tampoco sabe si el
 * canal es OpenWA o Cloud API. Ambas cosas están detrás de interfaces (Brain,
 * WhatsAppClient) — exactamente como manda el ADR-0003.
 */

import { consultarCatalogo, SCHEMA_CONSULTAR_CATALOGO } from './catalogo.mjs';

// Persona del agente (system prompt). El mock lo ignora; Claude/GPT real lo usa.
const SYSTEM_PROMPT = `Sos Sofía, asesora de belleza experta de Perfumería AFG (Paraguay).
Tu misión: ayudar a la clienta a encontrar el perfume perfecto y cerrar la venta,
hablando de forma cálida y natural, como una persona real — no como un bot.
Flujo: 1) entender para quién y qué estilo busca, 2) consultar el catálogo,
3) presentar máximo 3 opciones con descripción emotiva y precio en Guaraníes.`;

// Registro de tools disponibles (schema + implementación)
const TOOLS = [SCHEMA_CONSULTAR_CATALOGO];
const TOOL_IMPL = {
  consultar_catalogo: (input) => ({ productos: consultarCatalogo(input) }),
};

const MAX_ITERS = 5;

export class SalesAgent {
  constructor(brain, wa) {
    this.brain = brain;
    this.wa = wa;
    this.sesiones = new Map(); // customerId → messages[]
  }

  historial(id) {
    if (!this.sesiones.has(id)) this.sesiones.set(id, []);
    return this.sesiones.get(id);
  }

  async recibir(from, textoUsuario) {
    const messages = this.historial(from);
    messages.push({ role: 'user', content: textoUsuario });

    // Loop de tool-calling (igual que el de Claude)
    for (let i = 0; i < MAX_ITERS; i++) {
      const r = await this.brain.respond({ system: SYSTEM_PROMPT, messages, tools: TOOLS });

      if (r.stopReason === 'tool_use' && r.toolCalls.length) {
        // El cerebro pidió ejecutar tools → ejecutarlas y devolver resultados
        messages.push({ role: 'assistant', content: null, toolCalls: r.toolCalls });
        for (const call of r.toolCalls) {
          const impl = TOOL_IMPL[call.name];
          const resultado = impl ? impl(call.input) : { error: 'tool desconocida' };
          if (process.env.DEBUG) {
            console.log(`      ⚙️  [tool ${call.name}(${JSON.stringify(call.input)})]`);
          }
          messages.push({ role: 'tool', toolCallId: call.id, content: resultado });
        }
        continue; // volver a pensar con los resultados
      }

      // Respuesta de texto final → enviar al cliente
      messages.push({ role: 'assistant', content: r.text });
      await this.wa.sendText(from, r.text);
      return;
    }

    await this.wa.sendText(from, 'Dame un segundito, ya te confirmo ✨');
  }
}
