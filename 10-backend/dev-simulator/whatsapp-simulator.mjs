/**
 * Simulador de WhatsApp para AI_AFG — Perfumería
 * ================================================
 *
 * Permite probar el bot de ventas SIN Meta, SIN instalar nada.
 * Corre con Node puro: `node whatsapp-simulator.mjs`
 *
 * Demuestra la arquitectura del ADR-0003:
 *   El bot habla con la interfaz WhatsAppClient, NO con Meta directo.
 *   Hoy usa MockWhatsAppClient (este archivo). Mañana, el mismo bot
 *   usa CloudApiWhatsAppClient sin cambiar una línea de su lógica.
 *
 * Modos:
 *   node whatsapp-simulator.mjs          → conversación demo automática
 *   node whatsapp-simulator.mjs --chat   → chateás vos en la terminal
 */

import { createInterface } from 'node:readline';

// ============================================================
//  CATÁLOGO DEMO (en el sistema real esto vive en Firestore)
// ============================================================
const CATALOGO = [
  { id: 'p1', emoji: '🌸', nombre: 'Good Girl 80ml', marca: 'Carolina Herrera', precio: 650000, stock: 5 },
  { id: 'p2', emoji: '✨', nombre: 'La Vie Est Belle 50ml', marca: 'Lancôme', precio: 580000, stock: 3 },
  { id: 'p3', emoji: '🌹', nombre: 'Olympéa 50ml', marca: 'Paco Rabanne', precio: 520000, stock: 8 },
  { id: 'p4', emoji: '💎', nombre: 'Black Opium 90ml', marca: 'YSL', precio: 690000, stock: 2 },
];

const GS = (n) => '₲ ' + n.toLocaleString('es-PY');

// ============================================================
//  WhatsAppClient — la INTERFAZ (contrato del canal)
//  El bot solo conoce esto. No sabe si atrás hay Meta o un mock.
// ============================================================
class WhatsAppClient {
  async sendText(_to, _text) { throw new Error('no implementado'); }
}

// ============================================================
//  MockWhatsAppClient — adaptador de PRUEBA (corre local)
//  En vez de mandar a Meta, imprime en la terminal.
// ============================================================
class MockWhatsAppClient extends WhatsAppClient {
  async sendText(to, text) {
    for (const linea of text.split('\n')) {
      console.log('   🤖 BOT │ ' + linea);
    }
    console.log('');
  }
}

// ============================================================
//  EL BOT — lógica conversacional (independiente del canal)
//  Esta lógica es la que después se promueve a Cloud Functions.
// ============================================================
class BotPerfumeria {
  constructor(wa) {
    this.wa = wa;
    this.sesiones = new Map(); // customerId → { state, cart }
  }

  sesion(id) {
    if (!this.sesiones.has(id)) {
      this.sesiones.set(id, { state: 'GREETING', cart: [] });
    }
    return this.sesiones.get(id);
  }

  async recibir(from, texto) {
    const s = this.sesion(from);
    const msg = texto.trim().toLowerCase();

    // Comandos globales
    if (['hola', 'buenas', 'menu', 'inicio'].includes(msg) || s.state === 'GREETING') {
      s.state = 'BROWSING';
      return this.wa.sendText(from,
        '¡Hola! 💖 Bienvenida a *Perfumería AFG*\n' +
        'Soy tu asistente de ventas. ¿Qué querés hacer?\n\n' +
        '📋 Escribí *catálogo* para ver perfumes\n' +
        '🛒 Escribí *carrito* para ver tu pedido\n' +
        '💳 Escribí *pagar* para finalizar la compra');
    }

    if (msg === 'catálogo' || msg === 'catalogo' || msg === 'ver') {
      s.state = 'BROWSING';
      let t = '🌟 *Nuestros perfumes* 🌟\n\n';
      CATALOGO.forEach((p, i) => {
        t += `${p.emoji} *${i + 1}.* ${p.nombre} — ${p.marca}\n     ${GS(p.precio)}\n`;
      });
      t += '\n👉 Escribí el *número* del perfume para ver detalle.';
      return this.wa.sendText(from, t);
    }

    // Selección de producto por número
    const num = parseInt(msg, 10);
    if (!isNaN(num) && num >= 1 && num <= CATALOGO.length) {
      const p = CATALOGO[num - 1];
      s.state = 'VIEWING_PRODUCT';
      s.viendo = p.id;
      return this.wa.sendText(from,
        `${p.emoji} *${p.nombre}*\n` +
        `Marca: ${p.marca}\n` +
        `Precio: ${GS(p.precio)}\n` +
        `Stock: ${p.stock} disponibles\n\n` +
        '➕ Escribí *agregar* para sumarlo al carrito.');
    }

    if (msg === 'agregar' && s.viendo) {
      const p = CATALOGO.find((x) => x.id === s.viendo);
      s.cart.push(p);
      s.state = 'CART';
      const total = s.cart.reduce((a, x) => a + x.precio, 0);
      return this.wa.sendText(from,
        `✅ *${p.nombre}* agregado al carrito.\n` +
        `🛒 Llevás ${s.cart.length} producto(s) — Total: *${GS(total)}*\n\n` +
        'Escribí *catálogo* para seguir o *pagar* para finalizar.');
    }

    if (msg === 'carrito') {
      if (s.cart.length === 0) {
        return this.wa.sendText(from, '🛒 Tu carrito está vacío. Escribí *catálogo* para ver perfumes.');
      }
      let t = '🛒 *Tu carrito:*\n\n';
      s.cart.forEach((p) => { t += `${p.emoji} ${p.nombre} — ${GS(p.precio)}\n`; });
      const total = s.cart.reduce((a, x) => a + x.precio, 0);
      t += `\n*Total: ${GS(total)}*\n\nEscribí *pagar* para finalizar.`;
      return this.wa.sendText(from, t);
    }

    if (msg === 'pagar') {
      if (s.cart.length === 0) {
        return this.wa.sendText(from, '🛒 Tu carrito está vacío. Escribí *catálogo* primero.');
      }
      const total = s.cart.reduce((a, x) => a + x.precio, 0);
      s.state = 'AWAITING_PAYMENT';
      return this.wa.sendText(from,
        `💳 *Resumen de compra*\n` +
        `Total a pagar: *${GS(total)}*\n\n` +
        '🔗 Link de pago (simulado):\n' +
        'https://pago.perfumeriaafg.com/checkout/DEMO123\n\n' +
        '(En el sistema real este link sería de Bancard / Tigo Money / Stripe)');
    }

    // Fallback
    return this.wa.sendText(from,
      'No entendí 🤔. Escribí *catálogo*, *carrito* o *pagar*.');
  }
}

// ============================================================
//  RUNNER
// ============================================================
const wa = new MockWhatsAppClient();
const bot = new BotPerfumeria(wa);
const CLIENTE = '+595981123456'; // número de prueba

async function correrDemo() {
  const guion = ['hola', 'catálogo', '1', 'agregar', 'catálogo', '3', 'agregar', 'carrito', 'pagar'];
  console.log('\n══════════════════════════════════════════════');
  console.log('  SIMULADOR WhatsApp · Perfumería AFG (demo)');
  console.log('══════════════════════════════════════════════\n');
  for (const texto of guion) {
    console.log('👩 CLIENTA │ ' + texto);
    console.log('');
    await bot.recibir(CLIENTE, texto);
  }
  console.log('══════════════════════════════════════════════');
  console.log('  Fin de la demo. Probá vos: node whatsapp-simulator.mjs --chat');
  console.log('══════════════════════════════════════════════\n');
}

async function correrChat() {
  console.log('\n💬 Modo chat. Escribí mensajes (o "salir" para terminar).\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pregunta = () => rl.question('👩 Vos │ ', async (texto) => {
    if (texto.trim().toLowerCase() === 'salir') { rl.close(); return; }
    console.log('');
    await bot.recibir(CLIENTE, texto);
    pregunta();
  });
  pregunta();
}

if (process.argv.includes('--chat')) {
  correrChat();
} else {
  correrDemo();
}
