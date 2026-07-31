import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_ID_RE,
  PROVIDER_MESSAGE_ID_RE,
  attachmentStoragePartition,
  buildAttachmentDocPath,
  buildAttachmentStoragePath,
  deriveAttachmentId,
  hashProviderMessageId,
  isAttachmentId,
  isAttachmentStoragePath,
} from './attachmentIdentity.js';

const TENANT = 'tnt_k3mP9xZ1qR4w';
const OTRO_TENANT = 'tnt_a1b2c3d4e5f6';
// Datos de proveedor con la forma real (wamid largo + media id numérico). Nada de esto puede
// aparecer en el id ni en la ruta.
const WAMID = 'wamid.HBgMNTk1OTgxMTIyMzM0FQIAEhggQjZGN0E5RTM=';
const MEDIA_ID = '1234567890123456';

const base = { tenantId: TENANT, channel: 'whatsapp' as const, providerMessageId: WAMID, providerMediaId: MEDIA_ID };

describe('deriveAttachmentId — determinismo', () => {
  it('mismos insumos ⇒ mismo id (idempotencia del create() ante reintento del webhook)', () => {
    expect(deriveAttachmentId(base)).toBe(deriveAttachmentId({ ...base }));
  });

  it('forma `att_<24 hex>`', () => {
    const id = deriveAttachmentId(base);
    expect(id).toMatch(ATTACHMENT_ID_RE);
    expect(isAttachmentId(id)).toBe(true);
  });

  it('cambia con CUALQUIERA de los cuatro insumos', () => {
    const id = deriveAttachmentId(base);
    expect(deriveAttachmentId({ ...base, tenantId: OTRO_TENANT })).not.toBe(id);
    expect(deriveAttachmentId({ ...base, channel: 'instagram' })).not.toBe(id);
    expect(deriveAttachmentId({ ...base, providerMessageId: `${WAMID}x` })).not.toBe(id);
    expect(deriveAttachmentId({ ...base, providerMediaId: '1234567890123457' })).not.toBe(id);
  });

  it('la codificación es INYECTIVA: mover un carácter entre campos cambia el id', () => {
    const a = deriveAttachmentId({ ...base, providerMessageId: 'ab', providerMediaId: 'c' });
    const b = deriveAttachmentId({ ...base, providerMessageId: 'a', providerMediaId: 'bc' });
    expect(a).not.toBe(b);
  });

  it('recorta espacios (el mismo wamid con espacio de más no crea un adjunto nuevo)', () => {
    expect(deriveAttachmentId({ ...base, providerMediaId: ` ${MEDIA_ID} ` })).toBe(
      deriveAttachmentId(base),
    );
  });
});

describe('deriveAttachmentId — opacidad', () => {
  it('el id NO contiene el mediaId, ni el wamid, ni nada reversible a simple vista', () => {
    const id = deriveAttachmentId(base);
    expect(id).not.toContain(MEDIA_ID);
    expect(id).not.toContain('595981122334'); // el teléfono embebido en el wamid
    expect(id).not.toContain('wamid');
    expect(id.slice(4)).toMatch(/^[0-9a-f]{24}$/);
  });

  it('el error de validación no filtra el valor recibido', () => {
    for (const bad of [{ ...base, providerMediaId: '' }, { ...base, tenantId: '   ' }]) {
      expect(() => deriveAttachmentId(bad)).toThrowError(/attachmentIdentity: \w+ inválido/);
      try {
        deriveAttachmentId(bad);
      } catch (err) {
        expect((err as Error).message).not.toContain(MEDIA_ID);
        expect((err as Error).message).not.toContain(TENANT);
      }
    }
  });

  it('rechaza insumos no-string, vacíos o desmedidos', () => {
    expect(() => deriveAttachmentId({ ...base, providerMessageId: null as never })).toThrow();
    expect(() => deriveAttachmentId({ ...base, providerMediaId: 'x'.repeat(257) })).toThrow();
    expect(() => deriveAttachmentId(undefined as never)).toThrow();
  });
});

describe('hashProviderMessageId', () => {
  it('forma `pmid_<24 hex>`, determinístico y sin el valor crudo', () => {
    const hashed = hashProviderMessageId(TENANT, WAMID);
    expect(hashed).toMatch(PROVIDER_MESSAGE_ID_RE);
    expect(hashed).toBe(hashProviderMessageId(TENANT, WAMID));
    expect(hashed).not.toContain('wamid');
    expect(hashed).not.toContain('595981122334');
  });

  it('está salteado por tenant: el mismo wamid en dos tenants no es correlacionable', () => {
    expect(hashProviderMessageId(TENANT, WAMID)).not.toBe(hashProviderMessageId(OTRO_TENANT, WAMID));
  });

  it('no colisiona con el attachmentId derivado de los mismos insumos', () => {
    expect(hashProviderMessageId(TENANT, WAMID).slice(5)).not.toBe(
      deriveAttachmentId(base).slice(4),
    );
  });
});

describe('rutas de Storage y Firestore', () => {
  const id = deriveAttachmentId(base);

  it('la partición son los 2 primeros hex del id (función pura del id, sin reloj)', () => {
    const partition = attachmentStoragePartition(id);
    expect(partition).toMatch(/^[0-9a-f]{2}$/);
    expect(id.startsWith(`att_${partition}`)).toBe(true);
  });

  it('la ruta arranca con el tenant y no lleva PII', () => {
    const path = buildAttachmentStoragePath(TENANT, id);
    expect(path).toBe(`tenants/${TENANT}/attachments/${attachmentStoragePartition(id)}/${id}`);
    expect(path.startsWith(`tenants/${TENANT}/`)).toBe(true);
    expect(path).not.toContain(MEDIA_ID);
    expect(path).not.toContain('595981122334');
    expect(path).not.toContain('.jpg');
  });

  it('recalcular la ruta da siempre lo mismo (un reintento no deja bytes huérfanos)', () => {
    expect(buildAttachmentStoragePath(TENANT, id)).toBe(
      buildAttachmentStoragePath(TENANT, deriveAttachmentId(base)),
    );
  });

  it('rechaza tenantId con traversal o separadores', () => {
    for (const bad of ['../evil', 'a/b', '', '.', 'tnt/../x', 'x'.repeat(65)]) {
      expect(() => buildAttachmentStoragePath(bad, id)).toThrow();
      expect(() => buildAttachmentDocPath(bad, id)).toThrow();
    }
  });

  it('rechaza attachmentId que no tenga la forma derivada', () => {
    for (const bad of ['att_NOHEX', 'ord_123456789012', `att_${'a'.repeat(23)}`, '']) {
      expect(() => attachmentStoragePartition(bad)).toThrow();
      expect(() => buildAttachmentDocPath(TENANT, bad)).toThrow();
    }
  });

  it('la ruta del documento es tenants/{t}/attachments/{id}', () => {
    expect(buildAttachmentDocPath(TENANT, id)).toBe(`tenants/${TENANT}/attachments/${id}`);
  });
});

describe('isAttachmentStoragePath — whitelist estricta', () => {
  const id = deriveAttachmentId(base);
  const path = buildAttachmentStoragePath(TENANT, id);

  it('acepta la ruta canónica del tenant dueño', () => {
    expect(isAttachmentStoragePath(path, TENANT)).toBe(true);
  });

  it('rechaza otro tenant (aislamiento) y rutas cruzadas', () => {
    expect(isAttachmentStoragePath(path, OTRO_TENANT)).toBe(false);
    expect(isAttachmentStoragePath(buildAttachmentStoragePath(OTRO_TENANT, id), TENANT)).toBe(false);
  });

  it('rechaza traversal, prefijos y particiones que no correspondan al id', () => {
    expect(isAttachmentStoragePath(`tenants/${TENANT}/attachments/../../otro/${id}`, TENANT)).toBe(
      false,
    );
    expect(isAttachmentStoragePath(`${path}/extra`, TENANT)).toBe(false);
    expect(isAttachmentStoragePath(`/${path}`, TENANT)).toBe(false);
    expect(isAttachmentStoragePath(`tenants/${TENANT}/attachments/zz/${id}`, TENANT)).toBe(false);
    expect(isAttachmentStoragePath(`tenants/${TENANT}/orders/ord_1/comprobantes/x.jpg`, TENANT)).toBe(
      false,
    );
    expect(isAttachmentStoragePath(null, TENANT)).toBe(false);
    expect(isAttachmentStoragePath(path, '../evil')).toBe(false);
  });
});
