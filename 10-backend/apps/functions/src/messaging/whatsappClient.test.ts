import { describe, it, expect } from 'vitest';
import { MockWhatsAppClient, buildCloudApiTextBody } from './whatsappClient.js';

describe('whatsappClient', () => {
  it('MockWhatsAppClient no llama a Meta y responde ok', async () => {
    const r = await new MockWhatsAppClient().sendText('+595981111111', 'hola', { tenantId: 'perfumeria' });
    expect(r.ok).toBe(true);
    expect(r.viaMock).toBe(true);
  });

  it('buildCloudApiTextBody arma el payload correcto de Cloud API', () => {
    const b = buildCloudApiTextBody('595981111111', 'hola 🌸');
    expect(b).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '595981111111',
      type: 'text',
      text: { preview_url: false, body: 'hola 🌸' },
    });
  });
});
