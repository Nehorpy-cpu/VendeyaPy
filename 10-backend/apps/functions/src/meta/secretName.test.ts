import { describe, it, expect } from 'vitest';
import { metaTokenSecretName } from './secretName.js';

describe('metaTokenSecretName', () => {
  it('genera un name plano sin "/" para un tenant normal', () => {
    expect(metaTokenSecretName('perfumeria')).toBe('meta-token-perfumeria');
    expect(metaTokenSecretName('boutique-demo')).toBe('meta-token-boutique-demo');
  });

  it('sanitiza caracteres inválidos (incluido "/") → nunca rompe la ruta del doc', () => {
    expect(metaTokenSecretName('a/b c')).toBe('meta-token-a_b_c');
    expect(metaTokenSecretName('tnt/../x')).not.toContain('/');
  });
});
