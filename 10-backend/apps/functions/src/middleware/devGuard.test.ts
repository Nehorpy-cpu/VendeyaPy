import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { devEndpointAllowed } from './devGuard.js';

const reqWith = (secret?: string) => ({
  get: (n: string) => (n === 'x-internal-secret' ? secret : undefined),
});

describe('devEndpointAllowed (Fase 2: proteger + excluir de prod)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    delete process.env.ENABLE_DEV_ENDPOINTS;
    delete process.env.DEV_ENDPOINTS_SECRET;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('permite siempre en el emulador', () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    expect(devEndpointAllowed(reqWith())).toBe(true);
  });

  it('niega fuera del emulador sin flag ni secreto (producción)', () => {
    expect(devEndpointAllowed(reqWith('lo-que-sea'))).toBe(false);
  });

  it('niega si falta el header aunque haya flag + secreto', () => {
    process.env.ENABLE_DEV_ENDPOINTS = 'true';
    process.env.DEV_ENDPOINTS_SECRET = 'secreto-interno-largo-0000';
    expect(devEndpointAllowed(reqWith())).toBe(false);
  });

  it('niega con secreto incorrecto', () => {
    process.env.ENABLE_DEV_ENDPOINTS = 'true';
    process.env.DEV_ENDPOINTS_SECRET = 'secreto-interno-largo-0000';
    expect(devEndpointAllowed(reqWith('otro'))).toBe(false);
  });

  it('permite con flag + secreto + header correcto (staging/demo)', () => {
    process.env.ENABLE_DEV_ENDPOINTS = 'true';
    process.env.DEV_ENDPOINTS_SECRET = 'secreto-interno-largo-0000';
    expect(devEndpointAllowed(reqWith('secreto-interno-largo-0000'))).toBe(true);
  });
});
