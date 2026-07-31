import { describe, it, expect } from 'vitest';
import { ATTACHMENT_ALLOWED_MIME_TYPES } from '@vpw/shared';
import { parseAttachmentIngestLimits, DEFAULT_ATTACHMENT_LIMITS } from '../meta/attachmentLimits.js';
import {
  DEFAULT_RECEIPT_GATE_CONFIG,
  evaluateReceiptFile,
  mergeReceiptGateWithIngest,
  normalizeReceiptGateConfig,
} from './receiptGate.js';

/**
 * DISCRIMINANTE B4 — TEST QUE ATA LAS DOS CONFIGS. Los formatos y el tope de bytes se declaran en
 * DOS documentos por tenant: `config/attachments.ingest` (lo que se descarga y se guarda) y
 * `config/receiptGate` (lo que puede proponerse como comprobante). Son la MISMA decisión escrita
 * dos veces, y dos copias derivan: alcanza con que alguien toque una para que el sistema prometa
 * un formato que nunca va a llegar.
 *
 * Este archivo cruza los DOS normalizadores reales —el de `meta/` y el de `orders/`— y falla si
 * el gate efectivo llega a ser más permisivo que la ingesta en cualquiera de los dos ejes.
 */
describe('config de adjuntos — el gate nunca puede ser más permisivo que la ingesta', () => {
  /** Docs crudos como los escribiría un tenant desde el panel (o a mano). */
  const CASOS: Array<{ nombre: string; ingest: unknown; gate: unknown }> = [
    { nombre: 'los dos por default', ingest: undefined, gate: undefined },
    {
      nombre: 'el VECTOR del hallazgo: gate restringido a JPEG, ingesta por default',
      ingest: undefined,
      gate: { allowedMimeTypes: ['image/jpeg'] },
    },
    {
      nombre: 'al revés: ingesta restringida a JPEG y gate por default',
      ingest: { allowedMimeTypes: ['image/jpeg'] },
      gate: undefined,
    },
    {
      nombre: 'contradicción total: ingesta solo imágenes, gate solo PDF',
      ingest: { allowedMimeTypes: ['image/jpeg', 'image/png'] },
      gate: { allowedMimeTypes: ['application/pdf'] },
    },
    {
      nombre: 'bytes cruzados: la ingesta corta mucho antes que el gate',
      ingest: { maxBytes: 70_000 },
      gate: { maxBytes: 5 * 1024 * 1024 },
    },
    {
      nombre: 'bytes cruzados al revés: el gate corta antes',
      ingest: { maxBytes: 9 * 1024 * 1024 },
      gate: { maxBytes: 200_000 },
    },
    {
      nombre: 'config corrupta en los dos lados',
      ingest: { maxBytes: -1, allowedMimeTypes: ['application/x-msdownload'] },
      gate: { maxBytes: 'muchos', allowedMimeTypes: 'todos', windowMinutes: -5 },
    },
  ];

  for (const caso of CASOS) {
    it(`${caso.nombre}: el gate efectivo ⊆ ingesta`, () => {
      const limites = parseAttachmentIngestLimits(caso.ingest);
      const efectiva = mergeReceiptGateWithIngest(normalizeReceiptGateConfig(caso.gate), limites);

      // 1) Ningún formato proponible fuera de lo que la ingesta acepta guardar.
      for (const mime of efectiva.allowedMimeTypes) {
        expect(limites.allowedMimeTypes as readonly string[]).toContain(mime);
      }
      // 2) Ningún tamaño proponible por encima de lo que la ingesta llega a bajar.
      expect(efectiva.maxBytes).toBeLessThanOrEqual(limites.maxBytes);
      // 3) Y las dos siguen acotadas por la whitelist compartida (nadie habilita un tipo que el
      //    sniffing de magic bytes no sabe verificar).
      for (const mime of efectiva.allowedMimeTypes) {
        expect(ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).toContain(mime);
      }
    });
  }

  it('el VECTOR completo: un PDF que la ingesta guarda bien, el gate lo deja como MEDIO NORMAL', () => {
    const limites = parseAttachmentIngestLimits(undefined); // ingesta por default: acepta PDF
    const efectiva = mergeReceiptGateWithIngest(
      normalizeReceiptGateConfig({ allowedMimeTypes: ['image/jpeg'] }),
      limites,
    );
    expect(limites.allowedMimeTypes as readonly string[]).toContain('application/pdf');
    // El archivo se descarga y se guarda (eso es correcto: ADR-0016 §1, el adjunto existe ANTES
    // de cualquier clasificación); lo que no puede es proponerse como comprobante.
    expect(
      evaluateReceiptFile(
        { ingestState: 'stored', mimeVerified: 'application/pdf', bytes: 100_000, purgedAtMs: null },
        efectiva,
      ),
    ).toEqual({ ok: false, reason: 'mime_not_allowed' });
  });

  it('los DEFAULTS de los dos lados no se contradicen entre sí', () => {
    const efectiva = mergeReceiptGateWithIngest(DEFAULT_RECEIPT_GATE_CONFIG, DEFAULT_ATTACHMENT_LIMITS);
    expect(efectiva.allowedMimeTypes).toEqual([...ATTACHMENT_ALLOWED_MIME_TYPES]);
    expect(efectiva.maxBytes).toBe(Math.min(DEFAULT_RECEIPT_GATE_CONFIG.maxBytes, DEFAULT_ATTACHMENT_LIMITS.maxBytes));
    expect(efectiva.windowMs).toBe(DEFAULT_RECEIPT_GATE_CONFIG.windowMs);
  });
});
