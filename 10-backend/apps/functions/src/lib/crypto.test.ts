import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env['TENANT_SECRETS_ENCRYPTION_KEY'] =
    'test-key-must-be-at-least-32-chars-long-for-aes256';
  process.env['N8N_BASE_URL'] = 'http://localhost:5678';
  process.env['N8N_INTERNAL_SECRET'] = 'test-internal-secret-32-characters-min';
  process.env['WHATSAPP_WEBHOOK_VERIFY_TOKEN'] = 'test-verify-token';
  process.env['WHATSAPP_APP_SECRET'] = 'test-app-secret';
  process.env['API_BASE_URL'] = 'http://localhost:5001';
  process.env['WEB_BASE_URL'] = 'http://localhost:3000';
});

describe('crypto', () => {
  it('encrypt y decrypt son simétricos', async () => {
    const { encrypt, decrypt } = await import('./crypto.js');
    const plaintext = 'sensitive-token-value-12345';
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('produce ciphertext diferente para el mismo plaintext (IV random)', async () => {
    const { encrypt } = await import('./crypto.js');
    const a = encrypt('hola');
    const b = encrypt('hola');
    expect(a).not.toBe(b);
  });

  it('decrypt falla con ciphertext malformado', async () => {
    const { decrypt } = await import('./crypto.js');
    expect(() => decrypt('not-valid-format')).toThrow();
  });
});
