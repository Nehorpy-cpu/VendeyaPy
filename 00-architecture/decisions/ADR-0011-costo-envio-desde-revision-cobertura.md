# ADR-0011 — Costo de envío confirmado desde la revisión de cobertura (SHIPPING-CHAT)

**Fecha:** 2026-07-18
**Estado:** Aceptada (fundación en SHIPPING-CHAT-1; implementación operativa en fases 2–5, ver plan)
**Decisores:** Owner del proyecto (vía Codex)

---

## Contexto

Durante la revisión de cobertura (Coverage, ver el paquete `coverage.*`), el vendedor confirma en el chat del
panel si llega a la zona del cliente y **cuánto cuesta el envío** ("Sí llegamos, el costo de envío es ₲30.000").
Hoy ese costo se escribe como texto libre y **no** se estructura, no se suma al pedido ni se refleja en las
instrucciones bancarias. Se necesita capturar ese monto de forma **segura, auditable y determinística**, sumarlo
al total del pedido y mostrarlo separado, **sin** que un modelo de IA sea nunca autoridad financiera.

Contexto ya verificado (COVERAGE-SHIPPING-CHAT-COST-AUDIT-DESIGN-1):
- `OrderTotals` no tenía campo `shipping` (hoy `total == subtotal`, `discount` siempre 0).
- `grossProfit = subtotal - costo` vive en `orderFinancials` (privado, ADR-0008), anclado en **subtotal**.
- El total (`totals.total`) alimenta instrucciones bancarias, stats/ingresos, atribución/ROAS, Meta CAPI,
  `customer.spent`. Sumar envío al total exige decidir explícitamente qué consumidores usan producto vs. cobrado.
- `FREE_SHIPPING` existe como etiqueta de promo pero **ningún** código aplica promociones a un pedido.
- Coverage está **APAGADO** en producción; su activación está pausada.

## Decisión

### Flujo (autoridad humana + determinismo, la IA nunca decide dinero)
1. El vendedor escribe un **borrador natural** en el composer del chat del panel.
2. Un **parser determinístico compartido** (`@vpw/shared`, importado por web y backend) detecta el importe.
3. El vendedor **confirma explícitamente** el monto en una tarjeta de preview.
4. El **backend vuelve a parsear** el borrador (la autoridad final es el servidor) y exige coincidencia con el
   monto confirmado.
5. El backend genera un **mensaje canónico como vendedor**:
   > "El costo de envío para tu ubicación es ₲30.000."
   Este mensaje **no** repite dirección, coordenadas ni ninguna otra PII.
6. **La IA nunca determina ni modifica dinero.** Puede, a lo sumo, proponerse como sugerencia para lenguaje
   ambiguo en el frontend, pero jamás guardar/aprobar un monto sin confirmación humana.

### Saga/outbox idempotente (para la implementación futura, SHIPPING-CHAT-3)
- Reservar el **intento** y el **mensaje** con un **ID determinístico** (por `requestId`/`checkoutAttemptId`).
- Enviar el mensaje canónico del vendedor.
- Si **Meta confirma** el envío ⇒ persistir el `CoverageShippingQuote` + la aprobación + **exactamente un**
  resume job.
- Si la función **cae después** del envío, el retry **continúa sin reenviar** (at-most-once por el outbox).
- **Rechazo confirmado** de Meta ⇒ **no aprobar** cobertura.
- Resultado **`unknown`** ⇒ **no reenviar ni aprobar automáticamente**.
- **Sin quote confirmado NO hay orden ni datos bancarios.** El total con envío se persiste **antes** de emitir
  instrucciones bancarias, y el consumidor de reanudación mantiene la idempotencia (una orden, banco una vez).

### Contrato de aprobación con quote obligatorio
Cuando `config coverage.shippingQuote.required === true`:
- el `coverageApprove` antiguo deberá **rechazar** aprobaciones sin quote;
- la UI **no mostrará** el botón viejo de "Aprobar cobertura";
- **solo `coverageQuoteAndApprove`** podrá aprobar.
Ausente/`false` ⇒ el quote obligatorio está deshabilitado (comportamiento actual). La activación futura de Arfagi
deberá escribir `required=true` explícitamente.

### Modelo de totales y finanzas (definición canónica)
- `productNetRevenue = subtotal - discount`
- `totalCollected = productNetRevenue + shipping` (= `totals.total`)
- `grossProfit = productNetRevenue - productCost` (privado, ADR-0008; **no** incluye envío)
- **CAPI value, ROAS y margen EXCLUYEN el envío** (usan `productNetRevenue`): el envío es pass-through y no debe
  inflar la señal a Meta ni la eficiencia del anuncio.
- **`ingresos` cobrados y `customer.spent` INCLUYEN `totalCollected`** (es dinero realmente cobrado).
- El **gasto logístico privado** (lo que el negocio paga al delivery) queda **diferido**: por ahora el envío es
  pass-through puro, sin costo → sin margen de envío.

### Alcance de esta fundación y diferimientos
- **FREE_SHIPPING promocional queda DIFERIDO.** En esta versión el único ₲0 posible es un **quote confirmado de
  cero** (frase inequívoca de gratuidad), nunca inferido de texto publicitario.
- **Máximo de envío por defecto ₲5.000.000, configurable por tenant** (`coverage.shippingQuote.maxChargeGs`).
- **Coverage sigue OFF** hasta completar todas las fases (parser → UI → callable/outbox → orden/finanzas → E2E) y
  aprobar el **E2E real** de activación.

## Consecuencias

**Positivas:** el dinero de envío queda estructurado y auditable; la ganancia de productos no se contamina; la
ubicación exacta sigue confinada a `coverageRequests`; una sola lógica de parseo compartida entre web y backend
evita divergencias; la aprobación con quote obligatorio cierra el bypass del botón viejo.
**Negativas / a resolver en fases siguientes:** múltiples consumidores de `totals.total` deben distinguir
producto vs. cobrado (SHIPPING-CHAT-4, requiere aprobación del owner de las 4 rutas financieras); un campo extra
en `OrderTotals`; compatibilidad de lectura de órdenes viejas (helper `normalizeOrderTotals`). Ver ADR-0008
(finanzas privadas) y el reporte COVERAGE-SHIPPING-CHAT-COST-AUDIT-DESIGN-1.
