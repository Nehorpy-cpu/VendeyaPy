import { describe, it, expect } from 'vitest';
import { isValidEmail, resetOutcome, RESET_GENERIC_MESSAGE } from './password-reset';

describe('isValidEmail', () => {
  it('acepta emails con forma válida', () => {
    expect(isValidEmail('a@b.com')).toBe(true);
    expect(isValidEmail('  marco.nicolas@gmail.com  ')).toBe(true);
  });
  it('rechaza formatos inválidos', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('sin-arroba')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a @b.com')).toBe(false);
    expect(isValidEmail('a@b .com')).toBe(false);
    expect(isValidEmail('x'.repeat(250) + '@b.com')).toBe(false); // > 254
  });
});

describe('resetOutcome (mapeo seguro)', () => {
  it('éxito y user-not-found → MISMO mensaje genérico (no revela existencia)', () => {
    const ok = resetOutcome('');
    const notFound = resetOutcome('auth/user-not-found');
    expect(ok).toEqual({ kind: 'success', msg: RESET_GENERIC_MESSAGE });
    expect(notFound).toEqual({ kind: 'success', msg: RESET_GENERIC_MESSAGE });
    // ambos idénticos: imposible distinguir cuenta existente de inexistente
    expect(ok.msg).toBe(notFound.msg);
  });

  it('el mensaje genérico es el texto seguro requerido', () => {
    expect(RESET_GENERIC_MESSAGE).toBe(
      'Si existe una cuenta con ese correo, te enviaremos un enlace para restablecer tu contraseña.',
    );
  });

  it('errores operativos → mensaje específico amigable', () => {
    expect(resetOutcome('auth/invalid-email')).toMatchObject({ kind: 'error' });
    expect(resetOutcome('auth/too-many-requests').msg).toMatch(/intentos/i);
    expect(resetOutcome('auth/network-request-failed').msg).toMatch(/conexi/i);
  });

  it('cualquier otro código → fallback genérico de error', () => {
    const r = resetOutcome('auth/internal-error');
    expect(r.kind).toBe('error');
    expect(r.msg).toMatch(/no pudimos/i);
  });
});
