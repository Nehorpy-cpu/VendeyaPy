import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { devEndpointAllowed, guardDevEndpoint } from './devGuard.js';

const reqWith = (secret?: string) => ({
  get: (n: string) => (n === 'x-internal-secret' ? secret : undefined),
});

/** Res mínimo que registra las respuestas (status + body) para verificar el 404. */
function fakeRes() {
  const calls: { status: number; body: unknown }[] = [];
  return {
    calls,
    status(code: number) {
      return {
        json(body: unknown) {
          calls.push({ status: code, body });
          return undefined;
        },
      };
    },
  };
}

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

describe('guardDevEndpoint (corta el handler antes de mutar en prod)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.FUNCTIONS_EMULATOR;
    delete process.env.ENABLE_DEV_ENDPOINTS;
    delete process.env.DEV_ENDPOINTS_SECRET;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  // Simula un handler dev*: la "mutación" SOLO ocurre si el guard deja pasar (patrón real:
  // `if (!guardDevEndpoint(req, res)) return;` al inicio de cada endpoint dev).
  function runDevHandler(req: ReturnType<typeof reqWith>) {
    const res = fakeRes();
    let mutated = false;
    if (!guardDevEndpoint(req, res)) return { mutated, res };
    mutated = true; // lógica/escritura del endpoint
    return { mutated, res };
  }

  it('en producción: responde 404 y NO ejecuta la lógica (no muta datos)', () => {
    const { mutated, res } = runDevHandler(reqWith());
    expect(mutated).toBe(false);
    expect(res.calls).toEqual([{ status: 404, body: { ok: false, error: 'not found' } }]);
  });

  it('en el emulador: deja pasar (ejecuta la lógica) y no responde error', () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    const { mutated, res } = runDevHandler(reqWith());
    expect(mutated).toBe(true);
    expect(res.calls).toEqual([]);
  });

  it('en staging (flag + secreto + header correcto): deja pasar', () => {
    process.env.ENABLE_DEV_ENDPOINTS = 'true';
    process.env.DEV_ENDPOINTS_SECRET = 'secreto-interno-largo-0000';
    const { mutated, res } = runDevHandler(reqWith('secreto-interno-largo-0000'));
    expect(mutated).toBe(true);
    expect(res.calls).toEqual([]);
  });
});
