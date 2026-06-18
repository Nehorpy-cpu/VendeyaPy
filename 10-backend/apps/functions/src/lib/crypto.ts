/**
 * Cifrado simétrico para secretos de tenant (credenciales de WA, pagos).
 * Usa AES-256-GCM con la clave maestra TENANT_SECRETS_ENCRYPTION_KEY.
 *
 * IMPORTANTE: rotar la clave requiere migración de datos.
 */

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { getConfig } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT = Buffer.from('vpw-tenant-secrets-v1');

function deriveKey(): Buffer {
  const masterKey = getConfig().tenantSecretsEncryptionKey;
  return scryptSync(masterKey, SALT, 32);
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey();
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Formato: base64(iv):base64(tag):base64(ciphertext)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format');
  }
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
