/**
 * brain-mock.mjs — Cerebro SIMULADO del agente
 * =============================================
 * Imita el comportamiento de un LLM real (Claude / GPT) con tool-calling,
 * pero sin API key y sin costo. Reglas en vez de red neuronal.
 *
 * CLAVE: la interfaz Brain.respond({system, messages, tools}) → {text, toolCalls}
 * es EXACTAMENTE la forma del tool-use de Claude. Cuando se conecte el modelo
 * real (ClaudeBrain), el agente y el loop NO cambian — solo se reemplaza esta clase.
 */

// Interfaz que todo cerebro debe implementar (mock hoy, Claude/GPT mañana)
export class Brain {
  async respond(_req) { throw new Error('no implementado'); }
}

// ── Detección de intención (lo que el LLM real haría con comprensión de lenguaje) ──
function texto(messages) {
  return messages.filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content.toLowerCase()).join(' ');
}

function detectarEstilo(t) {
  const mapa = {
    dulce: ['dulce', 'azucarad', 'gourmand', 'vainilla'],
    floral: ['floral', 'flor', 'rosas', 'jazmín'],
    fresco: ['fresco', 'fresc', 'ligero', 'verano', 'cítric', 'limpio'],
    intenso: ['intenso', 'fuerte', 'noche', 'seductor', 'potente'],
    'árabe': ['árabe', 'arabe', 'lattafa', 'oud', 'oriental'],
    frutal: ['frutal', 'fruta'],
    amaderado: ['amaderad', 'madera', 'sensual'],
  };
  for (const [estilo, kws] of Object.entries(mapa)) {
    if (kws.some((k) => t.includes(k))) return estilo;
  }
  return null;
}

function detectarPresupuesto(t) {
  // número explícito (ej "500 mil", "300000")
  const mMil = t.match(/(\d+)\s*mil/);
  if (mMil) return { precio_max: parseInt(mMil[1], 10) * 1000 };
  const mNum = t.match(/(\d{5,7})/);
  if (mNum) return { precio_max: parseInt(mNum[1], 10) };
  if (/(económic|barat|accesible|poco|ajustad)/.test(t)) return { rango_precio: 'ACCESIBLE' };
  if (/(premium|caro|lujo|exclusiv|alto)/.test(t)) return { rango_precio: 'PREMIUM' };
  if (/(medio|intermedio|normal)/.test(t)) return { rango_precio: 'MID' };
  return {};
}

function tieneSenalDeBusqueda(t) {
  return detectarEstilo(t) || Object.keys(detectarPresupuesto(t)).length > 0 ||
    /(perfume|fragancia|busco|quiero|regalo|recomend|para ella|para mí|para mi)/.test(t);
}

export class MockBrain extends Brain {
  /**
   * @param {{system:string, messages:Array, tools:Array}} req
   * @returns {{text:string, toolCalls:Array, stopReason:string}}
   */
  async respond({ messages, tools }) {
    const ultimo = messages[messages.length - 1];

    // CASO 1: el último mensaje son resultados de tool → componer recomendación final
    if (ultimo.role === 'tool') {
      const productos = ultimo.content?.productos ?? [];
      if (productos.length === 0) {
        return {
          text: 'Mmm, no encontré algo que encaje justo con eso 🤔. ¿Querés que te muestre nuestras opciones más populares, o ajustamos el presupuesto?',
          toolCalls: [],
          stopReason: 'end_turn',
        };
      }
      return { text: presentarProductos(productos), toolCalls: [], stopReason: 'end_turn' };
    }

    const t = texto(messages);

    // CASO 2: saludo / sin info suficiente → asesoría (preguntar como una vendedora real)
    if (!tieneSenalDeBusqueda(t)) {
      return {
        text:
          '¡Hola! 💖 Soy Sofía, tu asesora de Perfumería AFG. Te ayudo a encontrar el perfume ideal ✨\n' +
          'Para recomendarte bien, contame: ¿es para vos o para regalar? ¿Y qué estilo te gusta — algo dulce, floral, fresco o más intenso?',
        toolCalls: [],
        stopReason: 'end_turn',
      };
    }

    // CASO 3: hay señal de búsqueda → el cerebro decide LLAMAR LA TOOL
    const tool = tools.find((x) => x.name === 'consultar_catalogo');
    const filtros = {
      genero: 'Femenino',
      ...(detectarEstilo(t) ? { estilo: detectarEstilo(t) } : {}),
      ...detectarPresupuesto(t),
      max_resultados: 3,
    };
    return {
      text: '',
      toolCalls: [{ id: 'call_1', name: tool.name, input: filtros }],
      stopReason: 'tool_use',
    };
  }
}

// Presentación natural (lo que el LLM generaría; acá plantillado pero con calidez)
function presentarProductos(productos) {
  const emoji = (p) =>
    p.estilos.includes('árabe') || p.estilos.includes('intenso') ? '🔥'
    : p.estilos.includes('dulce') || p.estilos.includes('gourmand') ? '🍬'
    : p.estilos.includes('fresco') || p.estilos.includes('cítrico') ? '🌊'
    : '🌸';

  let out = '✨ Mirá, te elegí estas opciones que creo te van a encantar:\n';
  for (const p of productos) {
    out += `\n${emoji(p)} *${p.nombre} – ${p.marca}* → ${p.precio_fmt}`;
    if (p.stock_critico) out += `  ⚠️ ¡Últimas ${p.stock} unidades!`;
    if (p.destacado) out += '\n   Uno de nuestros más vendidos 🌟';
    else if (p.nuevo) out += '\n   Recién llegado a nuestro catálogo ✨';
  }
  out += '\n\n¿Cuál te llama más la atención? Te cuento más de cualquiera 😊';
  return out;
}
