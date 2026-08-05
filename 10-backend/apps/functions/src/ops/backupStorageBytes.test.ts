/**
 * backupStorageBytes.test.ts — un backup de Storage que COPIA, no que lista (correctivo etapa F).
 * ==============================================================================================
 * «No llamar "backup restaurable completo" a un inventario.» `backup-storage.mjs` guardaba
 * nombre/tamaño/checksum y verificaba UNA MUESTRA; no copiaba un solo byte, no existía
 * `restore-storage.mjs`, y el E2E aprobaba con Storage ausente. Un restore de Firestore sin los
 * objetos deja adjuntos y comprobantes apuntando a rutas muertas.
 *
 * Acá se prueban las decisiones PURAS de la copia y del restore:
 *  · el nombre local de cada objeto es determinístico, seguro (sin traversal) y sin colisiones
 *    entre generaciones del mismo path;
 *  · la verificación local detecta un archivo corrompido ANTES de subir nada;
 *  · un conflicto en el destino (mismo path, contenido distinto) ABORTA salvo confirmación
 *    explícita — y jamás borra;
 *  · el veredicto final exige TODOS los objetos verificados: sin «salteados» que terminen en OK.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  nombreLocalDeObjeto,
  verificarCopiaLocal,
  decidirConflicto,
  veredictoDeRestauracion,
  validarBucketDestino,
} from '../../scripts/restore-storage.mjs';

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

describe('nombreLocalDeObjeto — determinístico, plano y sin colisiones', () => {
  it('el mismo objeto+generación da siempre el mismo nombre', () => {
    expect(nombreLocalDeObjeto('tenants/t1/products/p1/foto.bin', '123')).toBe(nombreLocalDeObjeto('tenants/t1/products/p1/foto.bin', '123'));
  });

  it('dos generaciones del MISMO path no colisionan', () => {
    expect(nombreLocalDeObjeto('tenants/t1/a.bin', '1')).not.toBe(nombreLocalDeObjeto('tenants/t1/a.bin', '2'));
  });

  it('es un nombre PLANO: sin separadores ni ".." aunque el path del bucket los traiga', () => {
    const n = nombreLocalDeObjeto('tenants/t1/../../etc/passwd', '9');
    expect(n).not.toMatch(/[\\/]/);
    expect(n).not.toContain('..');
  });
});

describe('verificarCopiaLocal — nada se sube sin verificar lo descargado', () => {
  const contenido = Buffer.from('bytes-del-comprobante');
  const linea = { nombre: 'tenants/t1/x.bin', tamano: contenido.length, sha256Contenido: sha256(contenido) };

  it('acepta la copia íntegra', () => {
    expect(verificarCopiaLocal(linea, contenido)).toEqual({ ok: true });
  });

  it('rechaza un archivo local corrompido (hash distinto)', () => {
    const r = verificarCopiaLocal(linea, Buffer.from('otra-cosa'));
    expect(r.ok).toBe(false);
  });

  it('rechaza un tamaño que no coincide aunque el hash lo hiciera', () => {
    const r = verificarCopiaLocal({ ...linea, tamano: 999 }, contenido);
    expect(r.ok).toBe(false);
  });
});

describe('decidirConflicto — el destino nunca pierde datos en silencio', () => {
  it('destino vacío ⇒ subir', () => {
    expect(decidirConflicto(null, 'abc', false)).toBe('subir');
  });

  it('destino con el MISMO contenido ⇒ idéntico (no re-subir, no fallar)', () => {
    expect(decidirConflicto('abc', 'abc', false)).toBe('identico');
  });

  it('destino DIVERGENTE sin confirmación ⇒ abortar', () => {
    expect(decidirConflicto('abc', 'zzz', false)).toBe('abortar');
  });

  it('destino divergente CON --sobrescribir ⇒ sobrescribir (jamás borrar)', () => {
    expect(decidirConflicto('abc', 'zzz', true)).toBe('sobrescribir');
  });
});

describe('validarBucketDestino — el bucket participa del candado (correctivo, CRÍTICO 3)', () => {
  const MANIFEST_PROD = 'vpw-prod-dd6ff.firebasestorage.app';

  it('fuera del emulador, SIN `--bucket` explícito NO se defaultea al del manifest (que puede ser el de prod)', () => {
    const r = validarBucketDestino({ valor: null, ambiguo: false }, MANIFEST_PROD, false);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('bucket_obligatorio');
  });

  it('`--bucket` repetido aborta en vez de caer en silencio al del manifest', () => {
    const r = validarBucketDestino({ valor: null, ambiguo: true }, MANIFEST_PROD, false);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('bucket_ambiguo');
  });

  it('un bucket con forma de PRODUCCIÓN se rechaza aunque el projectId sea demo-*', () => {
    const r = validarBucketDestino({ valor: MANIFEST_PROD, ambiguo: false }, null, false);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('bucket_produccion');
  });

  it('en el EMULADOR el default al bucket del manifest es aceptable (no hay red que tocar)', () => {
    const r = validarBucketDestino({ valor: null, ambiguo: false }, 'demo-aiafg.appspot.com', true);
    expect(r).toEqual({ ok: true, bucket: 'demo-aiafg.appspot.com' });
  });

  it('un bucket explícito y aislado pasa', () => {
    const r = validarBucketDestino({ valor: 'demo-restore-x.appspot.com', ambiguo: false }, MANIFEST_PROD, false);
    expect(r).toEqual({ ok: true, bucket: 'demo-restore-x.appspot.com' });
  });
});

describe('veredictoDeRestauracion — completo o fallado, sin medias tintas', () => {
  it('todos verificados ⇒ ok', () => {
    expect(veredictoDeRestauracion({ esperados: 3, subidos: 2, identicos: 1, verificados: 3, fallidos: 0, salteados: 0 }).ok).toBe(true);
  });

  it('un solo objeto sin verificar ⇒ falla', () => {
    expect(veredictoDeRestauracion({ esperados: 3, subidos: 3, identicos: 0, verificados: 2, fallidos: 0, salteados: 0 }).ok).toBe(false);
  });

  it('un «salteado» JAMÁS puede terminar en ok', () => {
    expect(veredictoDeRestauracion({ esperados: 3, subidos: 2, identicos: 0, verificados: 2, fallidos: 0, salteados: 1 }).ok).toBe(false);
  });

  it('un fallido ⇒ falla aunque el resto esté verde', () => {
    expect(veredictoDeRestauracion({ esperados: 3, subidos: 3, identicos: 0, verificados: 3, fallidos: 1, salteados: 0 }).ok).toBe(false);
  });
});
