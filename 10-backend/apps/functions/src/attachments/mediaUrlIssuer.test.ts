/**
 * mediaUrlIssuer.test.ts — Emisor de URLs temporales (WHATSAPP-MEDIA-SAFE-FOUNDATION-1, área C)
 * Cubre los casos del programa: cross-tenant denegado, path traversal, URL expirada, adjunto
 * purgado, MIME no verificado, PDF servido como descarga y comprobante legacy que sigue abriendo.
 */
import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_VIEW_URL_MAX_TTL_MS,
  ATTACHMENT_VIEW_URL_TTL_MS,
  buildDownloadFilename,
  buildEmulatorDownloadUrl,
  emulatorStorageHost,
  issueAttachmentViewUrl,
  presentationForMime,
  toAttachmentViewRecord,
  type AttachmentViewIssuerDeps,
  type AttachmentViewRecord,
  type SignedUrlRequest,
} from './mediaUrlIssuer.js';

const T = 'arfagi';
const OTRO_TENANT = 'credipower';
// Id determinístico real: la partición son sus 2 primeros hex ⇒ 'ab'.
const ATT = 'att_ab0123456789abcdef012345';
const ATT_PATH = `tenants/${T}/attachments/ab/${ATT}`;
const ORDER = 'ord_123';
const LEGACY_PATH = `tenants/${T}/orders/${ORDER}/comprobantes/wamid.ABC-123.jpg`;

const record = (over: Partial<AttachmentViewRecord> = {}): AttachmentViewRecord => ({
  tenantId: T,
  storagePath: ATT_PATH,
  ingestState: 'stored',
  verifiedMime: 'image/jpeg',
  filename: 'foto.jpg',
  purged: false,
  ...over,
});

interface Espia {
  firmados: SignedUrlRequest[];
  existsChecks: string[];
}

const deps = (
  over: Partial<AttachmentViewIssuerDeps> = {},
  espia: Espia = { firmados: [], existsChecks: [] },
): AttachmentViewIssuerDeps => ({
  loadAttachment: async () => record(),
  loadLegacyComprobanteRef: async () => LEGACY_PATH,
  fileExists: async (p) => {
    espia.existsChecks.push(p);
    return true;
  },
  signUrl: async (r) => {
    espia.firmados.push(r);
    // Se imita el formato de GCS: la expiración viaja DENTRO de la URL firmada.
    return `https://signed.example/${encodeURIComponent(r.path)}?X-Goog-Expires=${r.expiresAtMs}`;
  },
  ...over,
});

describe('TTL del enlace', () => {
  it('nunca supera los 10 minutos y la expiración se calcula sobre el reloj recibido', async () => {
    expect(ATTACHMENT_VIEW_URL_TTL_MS).toBeLessThanOrEqual(ATTACHMENT_VIEW_URL_MAX_TTL_MS);
    expect(ATTACHMENT_VIEW_URL_MAX_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
    const espia: Espia = { firmados: [], existsChecks: [] };
    const r = await issueAttachmentViewUrl(T, { kind: 'attachment', attachmentId: ATT }, deps({}, espia), 1_000_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.expiresAtMs).toBe(1_000_000 + ATTACHMENT_VIEW_URL_TTL_MS);
    // La expiración que se firmó es EXACTAMENTE la que se devuelve (la URL queda atada a ella).
    expect(espia.firmados[0]?.expiresAtMs).toBe(r.expiresAtMs);
  });

  it('URL expirada: pasado el vencimiento el objeto ya no se sirve', async () => {
    const ahora = 5_000_000;
    const r = await issueAttachmentViewUrl(T, { kind: 'attachment', attachmentId: ATT }, deps(), ahora);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Fake del lado de GCS: acepta mientras el reloj no pase la expiración firmada.
    const servir = (url: string, enMs: number): number => {
      const expira = Number(new URL(url).searchParams.get('X-Goog-Expires'));
      return enMs <= expira ? 200 : 403;
    };
    expect(servir(r.url, ahora + 60_000)).toBe(200);
    expect(servir(r.url, r.expiresAtMs)).toBe(200);
    expect(servir(r.url, r.expiresAtMs + 1)).toBe(403);
  });
});

describe('aislamiento por tenant', () => {
  it('cross-tenant: el documento declara OTRO tenant → permission-denied sin tocar Storage', async () => {
    const espia: Espia = { firmados: [], existsChecks: [] };
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'attachment', attachmentId: ATT },
      deps({ loadAttachment: async () => record({ tenantId: OTRO_TENANT }) }, espia),
    );
    expect(r).toMatchObject({ ok: false, code: 'permission-denied' });
    expect(espia.existsChecks).toHaveLength(0);
    expect(espia.firmados).toHaveLength(0);
  });

  it('cross-tenant: el path apunta a otra empresa → permission-denied sin firmar', async () => {
    const espia: Espia = { firmados: [], existsChecks: [] };
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'attachment', attachmentId: ATT },
      deps({ loadAttachment: async () => record({ storagePath: `tenants/${OTRO_TENANT}/attachments/ab/${ATT}` }) }, espia),
    );
    expect(r).toMatchObject({ ok: false, code: 'permission-denied' });
    expect(espia.firmados).toHaveLength(0);
  });

  it('comprobante legacy de OTRO tenant → permission-denied', async () => {
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'legacy_comprobante', orderId: ORDER },
      deps({ loadLegacyComprobanteRef: async () => `tenants/${OTRO_TENANT}/orders/${ORDER}/comprobantes/x.jpg` }),
    );
    expect(r).toMatchObject({ ok: false, code: 'permission-denied' });
  });
});

describe('path traversal y formas adulteradas', () => {
  const adulterados = [
    `tenants/${T}/attachments/ab/../../../secreto`,
    `tenants/${T}/attachments/ab/${ATT}/../otro`,
    `tenants/${T}/attachments/zz/${ATT}`, // partición que no corresponde al id
    `tenants/${T}/attachments/${ATT}`, // sin partición
    `tenants/${T}/attachments/ab/${ATT}/sub`,
    `tenants/${T}/products/p1/foto.jpg`,
    `../../${T}/attachments/ab/${ATT}`,
    '',
  ];
  it('rechaza todas las variantes sin llegar a Storage', async () => {
    for (const storagePath of adulterados) {
      const espia: Espia = { firmados: [], existsChecks: [] };
      const r = await issueAttachmentViewUrl(
        T,
        { kind: 'attachment', attachmentId: ATT },
        deps({ loadAttachment: async () => record({ storagePath }) }, espia),
      );
      expect(r.ok, `debería rechazar: ${storagePath}`).toBe(false);
      expect(espia.existsChecks).toHaveLength(0);
      expect(espia.firmados).toHaveLength(0);
    }
  });

  it('el comprobante legacy conserva su whitelist estricta (otra orden, subcarpeta, traversal)', async () => {
    const malos = [
      `tenants/${T}/orders/OTRA/comprobantes/x.jpg`,
      `tenants/${T}/orders/${ORDER}/comprobantes/sub/x.jpg`,
      `tenants/${T}/orders/${ORDER}/comprobantes/../../../x.jpg`,
    ];
    for (const ref of malos) {
      const r = await issueAttachmentViewUrl(
        T,
        { kind: 'legacy_comprobante', orderId: ORDER },
        deps({ loadLegacyComprobanteRef: async () => ref }),
      );
      expect(r, `debería rechazar: ${ref}`).toMatchObject({ ok: false, code: 'permission-denied' });
    }
  });

  it('un id de adjunto inválido no llega a Firestore', async () => {
    let tocado = false;
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'attachment', attachmentId: '../otro' },
      deps({
        loadAttachment: async () => {
          tocado = true;
          return record();
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid-argument' });
    expect(tocado).toBe(false);
  });
});

describe('estado del adjunto', () => {
  it('purgado por retención → not-found (no se firma un enlace a bytes que ya no existen)', async () => {
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'attachment', attachmentId: ATT },
      deps({ loadAttachment: async () => record({ purged: true }) }),
    );
    expect(r).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('todavía no almacenado → failed-precondition', async () => {
    for (const ingestState of ['received', 'downloading', 'verifying', 'rejected', 'download_failed'] as const) {
      const r = await issueAttachmentViewUrl(
        T,
        { kind: 'attachment', attachmentId: ATT },
        deps({ loadAttachment: async () => record({ ingestState }) }),
      );
      expect(r).toMatchObject({ ok: false, code: 'failed-precondition' });
    }
  });

  it('sin MIME verificado (o con uno hostil) NO se firma nada', async () => {
    for (const verifiedMime of [null, 'image/svg+xml', 'text/html', 'application/octet-stream']) {
      const espia: Espia = { firmados: [], existsChecks: [] };
      const r = await issueAttachmentViewUrl(
        T,
        { kind: 'attachment', attachmentId: ATT },
        deps({ loadAttachment: async () => record({ verifiedMime }) }, espia),
      );
      expect(r, `debería rechazar: ${verifiedMime}`).toMatchObject({ ok: false, code: 'failed-precondition' });
      expect(espia.firmados).toHaveLength(0);
    }
  });

  it('adjunto inexistente → not-found', async () => {
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'attachment', attachmentId: ATT },
      deps({ loadAttachment: async () => null }),
    );
    expect(r).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('archivo ausente en Storage → not-found', async () => {
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'attachment', attachmentId: ATT },
      deps({ fileExists: async () => false }),
    );
    expect(r).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('falla de firma → internal SIN filtrar detalles del bucket ni de la service account', async () => {
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'attachment', attachmentId: ATT },
      deps({
        signUrl: async () => {
          throw new Error('client_email missing for bucket gs://super-secreto');
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'internal' });
    if (!r.ok) {
      expect(r.message).not.toContain('secreto');
      expect(r.message).not.toContain('client_email');
    }
  });
});

describe('presentación: el PDF se descarga, la imagen se muestra', () => {
  it('PDF → attachment con Content-Type verificado', async () => {
    const espia: Espia = { firmados: [], existsChecks: [] };
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'attachment', attachmentId: ATT },
      deps({ loadAttachment: async () => record({ verifiedMime: 'application/pdf', filename: 'Transferencia.PDF' }) }, espia),
    );
    expect(r).toMatchObject({ ok: true, contentType: 'application/pdf', disposition: 'attachment' });
    expect(espia.firmados[0]?.filename).toBe('Transferencia.pdf');
  });

  it('imagen → inline con el MIME verificado (no el declarado ni la extensión)', async () => {
    const espia: Espia = { firmados: [], existsChecks: [] };
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'attachment', attachmentId: ATT },
      deps({ loadAttachment: async () => record({ verifiedMime: 'image/png', filename: 'recibo.jpg' }) }, espia),
    );
    expect(r).toMatchObject({ ok: true, contentType: 'image/png', disposition: 'inline' });
    // La extensión la impone el MIME verificado, no el nombre que mandó el cliente.
    expect(espia.firmados[0]?.filename).toBe('recibo.png');
  });

  it('el nombre de descarga se limpia y jamás conserva una extensión ejecutable', () => {
    expect(buildDownloadFilename('factura.exe', ATT, 'application/pdf')).toBe('factura.pdf');
    expect(buildDownloadFilename('../../etc/passwd', ATT, 'application/pdf')).toBe('passwd.pdf');
    expect(buildDownloadFilename('re"cibo; rm -rf', ATT, 'image/jpeg')).toBe('re_cibo_rm_-rf.jpg');
    expect(buildDownloadFilename(null, ATT, 'image/webp')).toBe(`${ATT}.webp`);
    expect(buildDownloadFilename('   ', ATT, 'image/png')).toBe(`${ATT}.png`);
    // Sin comillas ni saltos: el valor entra dentro de un header HTTP entre comillas.
    for (const nombre of ['a"b', "a\nb", 'a;b', 'ñandú.pdf']) {
      expect(buildDownloadFilename(nombre, ATT, 'application/pdf')).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });

  it('un MIME desconocido cae en binario neutro con descarga forzada', () => {
    expect(presentationForMime('text/html', 'x.html', ATT)).toMatchObject({
      contentType: 'application/octet-stream',
      disposition: 'attachment',
    });
  });
});

describe('comprobantes legacy (compatibilidad aditiva, ADR-0016 §7)', () => {
  it('sigue abriendo con su path histórico y sale inline como imagen', async () => {
    const espia: Espia = { firmados: [], existsChecks: [] };
    const r = await issueAttachmentViewUrl(T, { kind: 'legacy_comprobante', orderId: ORDER }, deps({}, espia));
    expect(r).toMatchObject({
      ok: true,
      family: 'legacy_comprobante',
      contentType: 'image/jpeg',
      disposition: 'inline',
    });
    expect(espia.firmados[0]?.path).toBe(LEGACY_PATH);
  });

  it('un comprobante legacy en PDF se sirve como descarga', async () => {
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'legacy_comprobante', orderId: ORDER },
      deps({ loadLegacyComprobanteRef: async () => `tenants/${T}/orders/${ORDER}/comprobantes/wamid.X.pdf` }),
    );
    expect(r).toMatchObject({ ok: true, contentType: 'application/pdf', disposition: 'attachment' });
  });

  it('extensión desconocida → binario neutro, nunca interpretado por el navegador', async () => {
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'legacy_comprobante', orderId: ORDER },
      deps({ loadLegacyComprobanteRef: async () => `tenants/${T}/orders/${ORDER}/comprobantes/wamid.X.html` }),
    );
    expect(r).toMatchObject({ ok: true, contentType: 'application/octet-stream', disposition: 'attachment' });
  });

  it('una "extensión" heredada del prototipo no se convierte en Content-Type', async () => {
    for (const sufijo of ['constructor', 'toString', '__proto__']) {
      const r = await issueAttachmentViewUrl(
        T,
        { kind: 'legacy_comprobante', orderId: ORDER },
        deps({ loadLegacyComprobanteRef: async () => `tenants/${T}/orders/${ORDER}/comprobantes/x.${sufijo}` }),
      );
      expect(r, sufijo).toMatchObject({
        ok: true,
        contentType: 'application/octet-stream',
        disposition: 'attachment',
      });
    }
  });

  it('referencias media:{id} y comprobante-simulado → mensaje claro, sin tocar Storage', async () => {
    for (const ref of ['media:MEDIA123', 'comprobante-simulado']) {
      const espia: Espia = { firmados: [], existsChecks: [] };
      const r = await issueAttachmentViewUrl(
        T,
        { kind: 'legacy_comprobante', orderId: ORDER },
        deps({ loadLegacyComprobanteRef: async () => ref }, espia),
      );
      expect(r).toMatchObject({ ok: false, code: 'failed-precondition' });
      expect(espia.existsChecks).toHaveLength(0);
    }
  });

  it('pedido sin comprobante → failed-precondition', async () => {
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'legacy_comprobante', orderId: ORDER },
      deps({ loadLegacyComprobanteRef: async () => null }),
    );
    expect(r).toMatchObject({ ok: false, code: 'failed-precondition' });
  });

  it('orderId con separadores no llega a Firestore', async () => {
    let tocado = false;
    const r = await issueAttachmentViewUrl(
      T,
      { kind: 'legacy_comprobante', orderId: '../otro/x' },
      deps({
        loadLegacyComprobanteRef: async () => {
          tocado = true;
          return LEGACY_PATH;
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid-argument' });
    expect(tocado).toBe(false);
  });
});

describe('rama de emulador: nunca persiste una credencial en el objeto', () => {
  const pedido = (over: Partial<SignedUrlRequest> = {}): SignedUrlRequest => ({
    path: ATT_PATH,
    expiresAtMs: 1_000_000 + ATTACHMENT_VIEW_URL_TTL_MS,
    contentType: 'image/jpeg',
    disposition: 'inline',
    filename: 'foto.jpg',
    ...over,
  });

  /** Doble del objeto de Storage que DELATA cualquier escritura de metadata. */
  const objeto = (metadata: Record<string, unknown> | null) => {
    const escrituras: unknown[] = [];
    const file = {
      getMetadata: async () => [metadata ? { metadata } : {}],
      // No está en `EmulatorStorageFile`: si el código volviera a escribir, este contador lo grita.
      setMetadata: async (m: unknown) => {
        escrituras.push(m);
      },
    };
    return { file, escrituras };
  };

  it('con un token YA existente emite el enlace y NO escribe nada en el objeto', async () => {
    const { file, escrituras } = objeto({ firebaseStorageDownloadTokens: 'tok-viejo,tok-2' });
    const url = await buildEmulatorDownloadUrl(file, '127.0.0.1:9199', 'bucket-dev', pedido());
    expect(url).toContain('token=tok-viejo');
    expect(escrituras).toHaveLength(0);
  });

  it('SIN token no se inventa uno: se falla en vez de sembrar una credencial eterna', async () => {
    for (const metadata of [null, {}, { firebaseStorageDownloadTokens: '' }]) {
      const { file, escrituras } = objeto(metadata);
      await expect(buildEmulatorDownloadUrl(file, '127.0.0.1:9199', 'bucket-dev', pedido())).rejects.toThrow();
      expect(escrituras, JSON.stringify(metadata)).toHaveLength(0);
    }
  });

  it('lo que debe descargarse (PDF) NO se emite: el emulador no puede forzar la descarga', async () => {
    const { file, escrituras } = objeto({ firebaseStorageDownloadTokens: 'tok-viejo' });
    await expect(
      buildEmulatorDownloadUrl(
        file,
        '127.0.0.1:9199',
        'bucket-dev',
        pedido({ contentType: 'application/pdf', disposition: 'attachment', filename: 'x.pdf' }),
      ),
    ).rejects.toThrow();
    expect(escrituras).toHaveLength(0);
  });

  it('en producción el host del emulador se IGNORA: se firma de verdad o no se emite', () => {
    expect(emulatorStorageHost({ NODE_ENV: 'production', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199' })).toBeNull();
    expect(emulatorStorageHost({ NODE_ENV: 'production', STORAGE_EMULATOR_HOST: 'http://127.0.0.1:9199' })).toBeNull();
    expect(emulatorStorageHost({ NODE_ENV: 'development', FIREBASE_STORAGE_EMULATOR_HOST: 'http://127.0.0.1:9199/' })).toBe(
      '127.0.0.1:9199',
    );
    // La suite de emuladores es desarrollo declarado aunque el runtime diga "production".
    expect(
      emulatorStorageHost({
        NODE_ENV: 'production',
        FUNCTIONS_EMULATOR: 'true',
        FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
      }),
    ).toBe('127.0.0.1:9199');
    expect(emulatorStorageHost({ NODE_ENV: 'development' })).toBeNull();
  });
});

describe('toAttachmentViewRecord — proyección defensiva del documento', () => {
  it('un doc vacío o con tipos raros nunca queda "listo para firmar"', () => {
    expect(toAttachmentViewRecord(T, undefined)).toBeNull();
    const raro = toAttachmentViewRecord(T, {
      tenantId: 42 as unknown as string,
      ingestState: { hack: true } as unknown as string,
      storage: { path: 99 as unknown as string },
      mime: { verified: [] as unknown as string },
      filename: 7 as unknown as string,
      purgedAt: null,
    });
    expect(raro).toMatchObject({
      tenantId: T,
      storagePath: null,
      ingestState: 'received',
      verifiedMime: null,
      filename: null,
      purged: false,
    });
  });

  it('purgedAt presente ⇒ purged', () => {
    expect(toAttachmentViewRecord(T, { purgedAt: { toMillis: () => 1 } })?.purged).toBe(true);
  });
});
