import { describe, it, expect } from 'vitest';
import { deriveAssistedState } from './whatsapp-activation';

describe('deriveAssistedState (modelo de 4 estados del owner, WM-2)', () => {
  it('conexión active → connected (sin importar la solicitud)', () => {
    expect(deriveAssistedState('active', 'pending')).toBe('connected');
    expect(deriveAssistedState('active', 'completed')).toBe('connected');
    expect(deriveAssistedState('active', null)).toBe('connected');
  });

  it('conexión conectada pero NO active → needs_review', () => {
    expect(deriveAssistedState('pending_review', null)).toBe('needs_review');
    expect(deriveAssistedState('permission_missing', 'completed')).toBe('needs_review');
    expect(deriveAssistedState('error', 'pending')).toBe('needs_review');
    expect(deriveAssistedState('expired', null)).toBe('needs_review');
  });

  it('sin conexión + solicitud pendiente → pending', () => {
    expect(deriveAssistedState('not_connected', 'pending')).toBe('pending');
    expect(deriveAssistedState(null, 'pending')).toBe('pending');
    expect(deriveAssistedState(undefined, 'pending')).toBe('pending');
  });

  it('sin conexión y sin solicitud (o cancelada/completada sin conexión) → none (mostrar CTA)', () => {
    expect(deriveAssistedState('not_connected', null)).toBe('none');
    expect(deriveAssistedState(null, null)).toBe('none');
    expect(deriveAssistedState('not_connected', 'cancelled')).toBe('none');
    expect(deriveAssistedState(null, 'completed')).toBe('none');
  });
});
