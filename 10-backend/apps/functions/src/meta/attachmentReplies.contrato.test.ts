/**
 * attachmentReplies.contrato.test.ts — El contrato entre el gate y la respuesta al cliente.
 *
 * Por qué existe: el gate de comprobante (`orders/receiptGate.ts`) y los textos que se le mandan al
 * cliente (`meta/attachmentReplies.ts`) viven en módulos distintos a propósito — `meta/` no puede
 * importar `orders/`, esa es la costura del ADR-0016 §4. El precio de ese desacople es que las dos
 * listas de motivos pueden desalinearse en silencio: durante este mismo programa se agregó
 * `attachment_purged` al gate y quedó SIN mensaje, así que un rechazo real habría caído al texto
 * genérico sin que nada avisara.
 *
 * Este test ata las dos listas. Si alguien suma un motivo de rechazo en el gate y no le escribe una
 * respuesta, acá se entera. El desacople sigue siendo deliberado; lo que deja de ser opcional es
 * mantenerlo coherente.
 */
import { describe, it, expect } from 'vitest';
import { RECEIPT_GATE_DENY_REASONS, type ReceiptGateDenyReason } from '../orders/receiptGate.js';
import { respuestaPorAdjunto, type AttachmentReplyReason } from './attachmentReplies.js';

/**
 * Comprobación de tipos: `AttachmentReplyReason` debe ser superconjunto de `ReceiptGateDenyReason`.
 *
 * OJO CON LO QUE ESTA LÍNEA *NO* GARANTIZA, porque ya nos falló una vez: `apps/functions/
 * tsconfig.json` excluye de la compilación todos los archivos `.test.ts` de `src`, así que
 * `pnpm -r typecheck` NUNCA la mira, y vitest transpila con esbuild sin verificar tipos. Es decir:
 * la línea sigue siendo documentación útil y una red en el editor,
 * pero no es una verificación que corra en ningún lado. Cuando el contrato dependía SOLO de esto
 * —más una lista de motivos repetida a mano acá abajo—, `receipt_gate_disabled` entró al gate sin
 * mensaje al cliente y ni el typecheck ni los 2000+ tests dijeron una palabra.
 *
 * Lo que de verdad sostiene el contrato es el recorrido de `RECEIPT_GATE_DENY_REASONS`, que es un
 * arreglo REAL en tiempo de ejecución del que se deriva el tipo. Un motivo nuevo aparece solo acá
 * abajo y, si nadie le escribió respuesta, el test falla de verdad.
 */
type _TodoMotivoDelGateTieneRespuesta = ReceiptGateDenyReason extends AttachmentReplyReason ? true : never;
const _prueba: _TodoMotivoDelGateTieneRespuesta = true;

/** LA fuente: el mismo arreglo del que sale el tipo. Nada que mantener a mano, nada que olvidar. */
const MOTIVOS_DEL_GATE: readonly ReceiptGateDenyReason[] = RECEIPT_GATE_DENY_REASONS;

describe('contrato gate ↔ respuesta al cliente', () => {
  it('la lista recorrida es la del gate, no una copia (si divergen, el contrato no verifica nada)', () => {
    expect(_prueba).toBe(true);
    expect(MOTIVOS_DEL_GATE.length).toBeGreaterThan(0);
    expect(new Set(MOTIVOS_DEL_GATE).size).toBe(MOTIVOS_DEL_GATE.length);
  });

  it('TODO motivo de rechazo del gate produce una respuesta no vacía', () => {
    for (const motivo of MOTIVOS_DEL_GATE) {
      for (const clase of ['image', 'document', 'unknown'] as const) {
        const texto = respuestaPorAdjunto(motivo, clase);
        expect(texto, `${motivo} / ${clase}`).toBeTruthy();
        expect(texto.trim().length, `${motivo} / ${clase}`).toBeGreaterThan(10);
      }
    }
  });

  /**
   * Motivos que comparten el texto genérico A PROPÓSITO. Los cuatro primeros son inconsistencias
   * INTERNAS: decirle al cliente "ese pedido es de otro cliente" o "tu adjunto ya estaba
   * clasificado" filtraría información del sistema y no le sirve para nada. El quinto es
   * literalmente la definición del genérico: sin contexto de pago, un archivo es un archivo.
   */
  const GENERICO_DELIBERADO: ReceiptGateDenyReason[] = [
    'tenant_mismatch',
    'customer_mismatch',
    'classification_not_open',
    'order_customer_mismatch',
    'no_explicit_payment_context',
  ];

  it('el nivel B apagado NO invita a *pagar*: con el gate off no existe vinculación posible', () => {
    // Es la ventana real del rollout (nivel A encendido, nivel B todavía no). El genérico dice
    // «escribí *pagar* y te paso los datos para vincularlo a tu pedido»; ahí sería mentira, porque
    // ni el gate automático ni `attachmentMarkAsReceipt` pueden vincular nada.
    for (const clase of ['image', 'document', 'unknown'] as const) {
      const texto = respuestaPorAdjunto('receipt_gate_disabled', clase);
      expect(texto).not.toBe(respuestaPorAdjunto(undefined, clase));
      expect(texto.toLowerCase()).not.toContain('pagar');
      // Tampoco promete una persona: sin nivel B no hay campana que respalde esa promesa (§11).
      expect(texto.toLowerCase()).not.toMatch(/asesor|vendedor|revisa/);
    }
  });

  it('cada motivo tiene texto propio, o está en la lista de genéricos deliberados', () => {
    // El valor de este test no es prohibir el genérico: es obligar a DECIDIR. Un motivo nuevo o
    // tiene su propia redacción, o queda explícitamente acá con su razón — nunca por olvido.
    const generico = respuestaPorAdjunto(undefined, 'image');
    const compartenGenerico = MOTIVOS_DEL_GATE.filter((m) => respuestaPorAdjunto(m, 'image') === generico);
    expect(compartenGenerico.sort()).toEqual([...GENERICO_DELIBERADO].sort());
  });

  it('los motivos internos NO le cuentan al cliente por qué falló de verdad', () => {
    // Un mensaje que dijera "el pedido pertenece a otro cliente" filtraría la existencia de ese
    // pedido. El genérico es la respuesta correcta, y tiene que seguir siéndolo.
    for (const motivo of ['tenant_mismatch', 'customer_mismatch', 'order_customer_mismatch'] as const) {
      const texto = respuestaPorAdjunto(motivo, 'image').toLowerCase();
      expect(texto).not.toMatch(/otro cliente|otra empresa|tenant|pertenece/);
    }
  });

  it('una recepción nunca queda muda: sin motivo también hay respuesta', () => {
    for (const clase of ['image', 'document', 'unknown'] as const) {
      expect(respuestaPorAdjunto(null, clase).trim()).not.toBe('');
      expect(respuestaPorAdjunto(undefined, clase).trim()).not.toBe('');
    }
  });
});
