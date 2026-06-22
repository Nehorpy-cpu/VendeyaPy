import { describe, it, expect, afterEach } from 'vitest';
import { FakeAiClient, HttpAnthropicClient, getAiClient } from './client.js';
import { AI_MODEL } from './pricing.js';

const params = { model: AI_MODEL, system: 's', messages: [{ role: 'user' as const, content: 'hola' }], maxTokens: 256 };

describe('ai/client', () => {
  afterEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('FakeAiClient devuelve el fixture (texto + usage)', async () => {
    const fake = new FakeAiClient({ text: 'fake reply', inputTokens: 11, outputTokens: 22 });
    const res = await fake.createMessage(params);
    expect(res.text).toBe('fake reply');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(res.toolUses).toEqual([]);
  });

  it('FakeAiClient con default cuando el fixture está vacío', async () => {
    const res = await new FakeAiClient().createMessage(params);
    expect(res.text).toBeTruthy();
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  });

  it('FakeAiClient con fail → lanza (lo maneja el gateway)', async () => {
    await expect(new FakeAiClient({ fail: true }).createMessage(params)).rejects.toThrow();
  });

  it('getAiClient sin API key y sin emulador → null (disabled, sin crash)', async () => {
    delete process.env.FUNCTIONS_EMULATOR;
    delete process.env.ANTHROPIC_API_KEY;
    expect(await getAiClient()).toBeNull();
  });

  it('getAiClient con API key (prod) → cliente real, sin tocar la red', async () => {
    delete process.env.FUNCTIONS_EMULATOR;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const client = await getAiClient();
    expect(client).toBeInstanceOf(HttpAnthropicClient); // construir el cliente NO hace ninguna llamada
  });
});
