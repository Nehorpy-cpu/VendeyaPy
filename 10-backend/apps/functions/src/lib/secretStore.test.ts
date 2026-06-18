import { describe, it, expect } from 'vitest';
import { FirestoreSecretStore } from './secretStore.js';

describe('SecretStore (token por referencia, sin texto plano)', () => {
  it('get() devuelve null para una referencia ajena (no toca Firestore ni descifra)', async () => {
    const store = new FirestoreSecretStore();
    expect(await store.get('secret://otro-backend/cosa')).toBeNull();
    expect(await store.get('no-es-una-referencia')).toBeNull();
  });

  it('set() RECHAZA nombres con "/" u otros inválidos (evita rutas de doc rotas — bug F4A)', async () => {
    const store = new FirestoreSecretStore();
    await expect(store.set('meta-token/perfumeria', 'tok')).rejects.toThrow(/inválido/i);
    await expect(store.set('con espacio', 'tok')).rejects.toThrow();
    await expect(store.set('a/b/c', 'tok')).rejects.toThrow();
  });
});
