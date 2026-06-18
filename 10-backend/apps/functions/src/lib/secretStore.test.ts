import { describe, it, expect } from 'vitest';
import { FirestoreSecretStore } from './secretStore.js';

describe('SecretStore (token por referencia, sin texto plano)', () => {
  it('get() devuelve null para una referencia ajena (no toca Firestore ni descifra)', async () => {
    const store = new FirestoreSecretStore();
    expect(await store.get('secret://otro-backend/cosa')).toBeNull();
    expect(await store.get('no-es-una-referencia')).toBeNull();
  });
});
