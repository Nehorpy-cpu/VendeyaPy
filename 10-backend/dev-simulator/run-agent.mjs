/**
 * run-agent.mjs — Runner del agente con cerebro simulado
 * ======================================================
 *   node run-agent.mjs            → conversación demo automática
 *   node run-agent.mjs --chat     → chateás vos
 *   DEBUG=1 node run-agent.mjs    → muestra las llamadas internas a tools
 *
 * Demuestra el agente de ventas con IA (mock) end-to-end, antes de gastar
 * un solo token de API. Cuando se conecte Claude/GPT real, este runner no cambia.
 */

import { createInterface } from 'node:readline';
import { MockBrain } from './brain-mock.mjs';
import { SalesAgent } from './agent.mjs';

// MockWhatsAppClient — imprime en terminal en vez de mandar a Meta
class MockWhatsAppClient {
  async sendText(_to, text) {
    for (const linea of text.split('\n')) console.log('   🤖 SOFÍA │ ' + linea);
    console.log('');
  }
}

const agent = new SalesAgent(new MockBrain(), new MockWhatsAppClient());
const CLIENTE = '+595981123456';

async function demo() {
  const guion = [
    'hola',
    'es un regalo para mi novia, algo dulce',
    'mi presupuesto es como 600 mil',
    'contame más del primero',
  ];
  console.log('\n══════════════════════════════════════════════════');
  console.log('  AGENTE DE VENTAS IA (cerebro simulado) · AFG');
  console.log('══════════════════════════════════════════════════\n');
  for (const msg of guion) {
    console.log('👩 CLIENTA │ ' + msg + '\n');
    await agent.recibir(CLIENTE, msg);
  }
  console.log('══════════════════════════════════════════════════');
  console.log('  Probá vos: node run-agent.mjs --chat');
  console.log('══════════════════════════════════════════════════\n');
}

async function chat() {
  console.log('\n💬 Chat con Sofía (escribí "salir" para terminar)\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const loop = () => rl.question('👩 Vos │ ', async (msg) => {
    if (msg.trim().toLowerCase() === 'salir') return rl.close();
    console.log('');
    await agent.recibir(CLIENTE, msg);
    loop();
  });
  loop();
}

if (process.argv.includes('--chat')) chat();
else demo();
