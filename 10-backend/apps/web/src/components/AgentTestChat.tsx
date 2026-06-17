'use client';

import { useState } from 'react';

/**
 * Chat de prueba: habla con el agente real (endpoint devMessage) usando la config
 * y los productos reales de la empresa. Reset = nueva sesión de prueba.
 */

interface Msg {
  who: 'user' | 'bot';
  text: string;
}

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:5001/demo-aiafg/us-central1';

export function AgentTestChat({ tenantId }: { tenantId: string }) {
  const [testPhone, setTestPhone] = useState(() => '+595' + Math.floor(900000000 + Math.random() * 99999999));
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setMessages((m) => [...m, { who: 'user', text }]);
    setSending(true);
    try {
      const res = await fetch(`${API}/devMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: testPhone, text, tenantId }),
      });
      const data = await res.json();
      const reply = data.reply || (data.handledByHuman ? '(el bot está en pausa)' : '(sin respuesta)');
      setMessages((m) => [...m, { who: 'bot', text: reply }]);
    } catch {
      setMessages((m) => [...m, { who: 'bot', text: '⚠️ No se pudo conectar con el agente (¿emulador encendido?).' }]);
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setMessages([]);
    setTestPhone('+595' + Math.floor(900000000 + Math.random() * 99999999));
  };

  return (
    <div className="flex h-[28rem] flex-col rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
        <span className="text-sm font-semibold text-gray-700">🧪 Chat de prueba</span>
        <button onClick={reset} className="text-xs text-gray-500 hover:underline">Reiniciar</button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-center text-sm text-gray-400">
            Escribí un mensaje para probar al agente con la config y los productos reales.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.who === 'user' ? 'text-right' : 'text-left'}>
            <div
              className={
                'inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ' +
                (m.who === 'user' ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-800')
              }
            >
              {m.text}
            </div>
          </div>
        ))}
        {sending && <div className="text-left text-xs text-gray-400">Sofía está escribiendo…</div>}
      </div>
      <div className="flex gap-2 border-t border-gray-200 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Escribí como un cliente…"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        <button
          onClick={send}
          disabled={sending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          Enviar
        </button>
      </div>
    </div>
  );
}
