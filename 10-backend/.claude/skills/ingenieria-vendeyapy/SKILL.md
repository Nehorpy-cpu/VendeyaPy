---
name: ingenieria-vendeyapy
description: Estándar de ingeniería para escribir, auditar y verificar código de VendeYaPy — backend Firebase/TypeScript y panel Next.js. Usar al implementar cualquier programa, arreglar un defecto, revisar código de forma adversarial, o antes de tocar el webhook, checkout, pedidos, pagos, autorización, multi-tenant o cualquier superficie con dinero o datos de clientes.
---

# Estándar de ingeniería — VendeYaPy

Sistema en producción con un negocio real encima. Cada defecto que se escapa lo paga un cliente
que no recibe respuesta o un vendedor que pierde una venta. Este documento es el estándar que
mantiene ese riesgo bajo.

## 1. El ciclo, sin atajos

**Auditar → implementar → verificar → revisar → cerrar.** No se reordena y no se saltea.

### Fase 0 — auditoría antes de escribir la primera línea
Leé el código real. **No infieras contratos, no confíes en los comentarios, no confíes en la
documentación del repo.** Respondé las preguntas del programa con `archivo:línea` y reportá los
hallazgos antes de tocar nada.

Cuando la documentación y el código difieran, **gana el código, y lo señalás**.

### Implementación
El cambio **más chico** que resuelva el problema, compatible con la arquitectura existente.
Preferí patrones, librerías y convenciones que ya están en el repo. **Nada de refactors
oportunistas ni de «ya que estoy».** Si el arreglo correcto ya existe en otro módulo, reusalo en
vez de diseñar uno nuevo.

### Verificación
Números reales por suite, con exit codes reales. «Todo verde» no es un reporte.

### Review adversarial
Obligatoria cuando el cambio toca dinero, pedidos, pagos, privacidad, multi-tenant, autorización,
deploy o rollback.

## 2. RED-first, y que falle por el motivo correcto

Todo comportamiento nuevo empieza por un test que falla. Y no alcanza con que falle: **verificá
que falla por el motivo que esperás**, no por un typo, un mock mal armado o un import roto.

Un ejemplo real de RED honesto: `expected 200 not to be 200` — el defecto exacto, visible en el
mensaje del test.

### Nunca aflojes un test para que pase
Si un test existente falla después de tu cambio, hay tres posibilidades y **tenés que determinar
cuál es** antes de tocarlo:

1. **Tu cambio rompió algo** → arreglá el código, no el test.
2. **El test fijaba el defecto que estás corrigiendo** → se **invierte y se refuerza**: la
   aserción nueva es más fuerte que la vieja, y el motivo queda documentado **en el lugar**, con
   referencia a la evidencia que lo refutó.
3. **Es un flake preexistente** → demostralo: stash de tu diff, correr en el commit base,
   confirmar que falla igual. Documentalo y **no lo arregles** si está fuera de alcance.

Caso real de (2): un test afirmaba «un `messages` que falla NO cambia el código de respuesta».
Fijaba el defecto que perdía mensajes de clientes. Se invirtió a `expect(503)` + `retry: true` +
`liveWriteFailures === 1` — de una aserción a tres — con el razonamiento escrito arriba.

## 3. Seguridad — los patrones que este proyecto ya aprendió

### Guards dentro de la transacción, no antes
Un chequeo antes de escribir deja una ventana TOCTOU: entre la lectura y el commit, otro proceso
reclama el mismo recurso. **El guard que autoriza corre dentro de la transacción que escribe**, y
recibe la transacción como argumento para que no se pueda llamar «por las dudas» desde afuera.

Referencia en el repo: `meta/pnidOwnership.ts` (`assertPnidLibre`, `assertWabaLibre`).

### Fail-closed ante ambigüedad
Un dato ausente, corrupto o a medio escribir se trata como **prohibido**, no como permitido.

Regla de decisión: preguntate qué cuesta cada error. Tratar «libre» algo ocupado significa
quedarse con el ruteo de otro negocio; tratar «ocupado» algo libre solo obliga a un humano a
mirar. **La asimetría decide.**

Aplicado a flags: ausente, `false`, `"true"` (string), `1` y cualquier forma que no sea el
booleano exacto `true` significan APAGADO. Un error de lectura también apaga.

### Autorización: validar el destino, no solo al que llama
Autenticar al llamador no alcanza. Si la operación toca a **otro** usuario, tenant o recurso,
**validá el destino**: que pertenezca al mismo tenant, que tenga un rol asignable, que no esté
desactivado.

Referencia: `conversation/lifecycle.ts` valida el destino contra `users/{uid}` dentro de la
transacción.

### Errores uniformes contra la enumeración
Todos los motivos de rechazo devuelven **el mismo error**. Si «no existe», «es de otra empresa» y
«está desactivado» dan errores distintos, un atacante enumera usuarios probando.

### Idempotencia real
Clave determinística + `create()` que falla si ya existe + lease con fencing. Un webhook
reintentado, un botón cliqueado dos veces o un job reanudado **no pueden duplicar** un pedido, un
cobro ni una reserva.

Y al revés: si la operación es idempotente, **decilo y probalo** — habilita responder «reintentá»
sin miedo, que muchas veces es la solución correcta y más simple.

### Transiciones monotónicas
Los estados que solo avanzan (pendiente < enviado < entregado < leído) no retroceden por un evento
tardío. **Jamás inferir un estado que el proveedor no reportó.**

### Nunca borrado físico
Ni pedidos, ni mensajes, ni adjuntos, ni auditoría, ni evidencia financiera. `softDelete`
reversible y auditado.

### Aislamiento multi-tenant en cada query
Toda lectura y escritura lleva su filtro de tenant. El `tenantId` sale del token, **nunca de un
parámetro que el cliente controla** (salvo PLATFORM_ADMIN, que debe indicarlo explícitamente).

### Los gates bloquean acciones externas, jamás limpieza local
Cuando una relación o un flag bloquea algo, bloquea las **acciones hacia afuera** (escribir a un
proveedor, publicar, cobrar). El sweep de una cola, la confirmación de lo ya enviado, el descarte
y el cierre de avisos corren **siempre** — si no, el sistema se deadlockea contra sí mismo.

### PII: un identificador puede serlo sin parecerlo
**El wamid de WhatsApp lleva el teléfono del cliente en base64.** Antes de mandar un identificador
completo a un log, decodificalo y miralo. Si no podés verificarlo, va enmascarado.

Nunca a logs, auditoría ni respuestas: tokens, URLs firmadas, secretos, teléfonos completos,
contenido de mensajes. Las URLs firmadas son efímeras y **jamás se persisten**.

### La IA jamás decide dinero
El modelo describe y recomienda. Precios y stock salen **siempre** del catálogo server-side, nunca
generados. Toda salida del modelo de la que dependa el código se valida con esquema. El input del
cliente es hostil: asumí prompt injection en cada turno.

## 4. Fallas silenciosas — el defecto más caro

El patrón que más daño hizo en este proyecto: **algo falla y nadie se entera.**

Casos reales:
- El webhook respondía `200 ok` aunque la escritura del mensaje fallara ⇒ Meta no reintentaba ⇒
  **el mensaje del cliente desaparecía sin rastro**.
- El envío de WhatsApp caía a mock **en silencio** si la conexión se degradaba ⇒ los clientes
  dejaban de recibir respuestas y nadie lo notaba.
- El «🎉 ¡Pago confirmado!» se construía y **los dos llamadores descartaban el mensaje**.
- Tres campos configurables en el panel que el motor **nunca lee**.

Al escribir o revisar, preguntate siempre:
- ¿Este `catch` se traga un error que alguien debería ver?
- ¿Este «best-effort» debería avisar cuando falla?
- Si el proceso muere entre estas dos escrituras no transaccionales, ¿qué queda a medias?
- ¿Este resumen distingue «no había nada que hacer» de «no pude hacerlo»?
- ¿Esta configuración que se guarda, alguien la lee?
- ¿Este botón que reacciona, ejecuta algo?

**Un ACK optimista es una mentira.** No respondas éxito antes de saber que el efecto ocurrió.

## 5. Frontend

- Estados completos siempre: cargando, vacío, **error**, éxito. Una mutación sin rama de error
  deja al usuario creyendo que guardó.
- El servidor manda; la UI espeja. Nunca dupliques la regla de negocio en el cliente.
- Nada de botones falsos: si la funcionalidad no existe, el panel no la promete.
- Accesibilidad: labels, foco, teclado, contraste.
- Responsive real, verificado en navegador (desktop y móvil), sin texto encimado.
- Si el cambio es de backend, **el panel no cambia**: `git diff --stat` sobre el panel debe salir
  vacío, y se reporta como evidencia.
- **Compatibilidad de contratos**: cuando hay una versión del panel desplegada y otra en repo sin
  desplegar, un cambio de contrato rompe una de las dos. Los cambios de respuesta son **aditivos**
  (campos nuevos que el panel viejo ignora), nunca de forma.

## 6. Costos — decisiones que se pagan todos los meses

- **`maxInstances` en toda function expuesta.** Es el único techo *duro* de gasto de cómputo; los
  presupuestos de la nube son alertas, no topes.
- **Prompt caching** sobre el prefijo estable (tools → system → config del tenant). Es la palanca
  que más mueve la factura del LLM.
- **Contabilizá los tokens de caché** al calcular costo: si no, los números dejan de reflejar lo
  facturado.
- **Cota dura del historial.** La API factura todo el contexto en cada llamada; en loops de tools
  el crecimiento es cuadrático.
- **Las respuestas determinísticas son gratis.** Antes de mandar un turno al modelo, preguntate si
  una regla lo resuelve. Navegación, carrito, selección y cobertura ya se resuelven por reglas.
- Región de la base y política de limpieza de artefactos: decisiones estructurales, caras de
  revertir. Verificalas temprano.

## 7. Verificación — números, no adjetivos

Antes de cerrar:

```
pnpm -r typecheck && pnpm -r lint && pnpm -r build && pnpm -r test && git diff --check
```

Se reportan los **números por suite** y los **exit codes reales**.

E2E en emuladores limpios cuando la superficie lo amerite: `--project demo-aiafg` +
`seed-users.mjs` + `load-catalog.mjs` **dentro del mismo `exec`**.

Trampas verificadas:
- `cmd | grep` enmascara exit codes → PIPESTATUS o archivos.
- En Windows el `exec` corre con cmd.exe: `VAR=x cmd` no funciona; exportar en el proceso padre.
- Los `.test.ts` **no se typechequean** (el tsconfig los excluye y vitest no tiene `typecheck`):
  el typecheck en 0 no cubre los tests.
- **No hay CI.** Nada obliga a correr la batería, por eso se exigen exit codes reales.

## 8. Review adversarial — método de refutación

No busques confirmar que el código está bien. **Intentá romperlo.** Cada hallazgo se intenta
refutar contra el código real o se reproduce; **solo se reporta lo que sobrevive**, clasificado
CRÍTICO / ALTO / MEDIO / BAJO, y diciendo si bloquea el release.

Foco prioritario, en orden:

1. **El defecto que introdujo el propio arreglo.** Es el que más veces mordió a este proyecto. Si
   el fix quitó un guard, seguí el camino completo y confirmá que el bloqueo sigue existiendo en
   otro lado.
2. Caminos que quedan mudos: el cliente escribe y no recibe nada.
3. Promesas al cliente sin señal para nadie del lado del vendedor.
4. Checks que **no se ejecutan** en ningún lado.
5. Falsos positivos: comandos que salen con éxito sin haber hecho nada.

Un hallazgo sin `archivo:línea` o sin reproducción **no existe**. Un NO_GO bien fundado vale más
que una aprobación cómoda. Si no encontrás nada, decilo derecho.

## 9. Honestidad — innegociable

- **Nunca declares «listo» sin verificar.** Completo significa validado con evidencia.
- **Nunca falsees ni resumas resultados de tests.** Si algo quedó rojo, se dice, con la salida.
- **Nunca quites una feature en silencio** para que un error desaparezca.
- **Nunca pises cambios del usuario** ni commitees sus archivos sin seguimiento.
- Un número que no verificaste en **esta** sesión se marca `⚠️ verificar`, no se copia.
- Si no pudiste verificar algo, **decí por qué**.
- Distinguí siempre lo probado en emulador de lo probado en producción, con esas palabras.

## 10. Lo que exige confirmación explícita del owner

- **Cualquier deploy a producción. Siempre. Sin excepción.**
- Borrar carpetas, `git push --force`, `git reset --hard`, borrado recursivo.
- Cambiar el stack sin ADR previo.
- Tocar `_archive/`, `80-creditos.future/`, `credipower`, el tenant en revisión de Meta, o el feed
  del tenant.
- Modificar `.env` con credenciales, o instalar dependencias nuevas sin justificación.

## 11. Cierre

Reporte de **9 campos**: qué se auditó · causa raíz · cambios · archivos · tests y regresiones con
números reales · commit · estado de deploy · riesgos y pendientes · próximo prompt recomendado.

Después: entrada nueva en la bitácora (append, jamás editar entradas viejas) y reescritura del
estado. Un commit coherente y push normal — **nada de amend ni force**.
