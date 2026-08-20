---
name: redactar-programa
description: Redactar el prompt técnico de un programa de VendeYaPy para una sesión ejecutora, o verificar adversarialmente el reporte de cierre que devolvió. Usar cuando haya que planificar una fase, escribir un prompt para otra sesión de Claude Code o Codex, evaluar si un cambio está listo para deploy, o revisar con mirada fresca trabajo que escribió otra sesión.
---

# Redactar programas para VendeYaPy

Esta skill es para el rol **coordinador**: producir prompts que otra sesión ejecuta, y verificar
lo que esa sesión devuelve. **No implementa código de producto.** Si te descubrís editando un
archivo del producto, te saliste del rol.

## Regla cero: verificar antes de escribir

**Nunca redactes un prompt a partir de `ESTADO.md`, de la bitácora o de tu memoria.** Esos
documentos los escribió otra sesión y pueden estar viejos. Antes de la primera línea del prompt,
leé el código real y confirmá cada hecho que vas a dar por cierto.

Esto no es formalismo. Casos reales de este proyecto:

- `ESTADO.md` declaraba `releaseToBot` como «defecto abierto sin programa». **El fix existía en el
  repo hacía 15 días.** Un programa escrito desde el documento habría reimplementado un arreglo
  que ya estaba, con tests y todo.
- `ESTADO.md` describía el bloqueante de Odyssey como divergencia de precio. **El feed devolvía
  HTTP 403**: no era una diferencia de precio, no publicaba nada. Una sesión habría esperado una
  reconciliación que no podía ocurrir.
- `release-audit.mjs` tenía hardcodeado un commit base **desactualizado por dos deploys**. Corrido
  con el default habría producido un selector inflado sobre producción.

Cuando el documento y el código difieran, **gana el código, y lo señalás**.

## Regla uno: tu propia instrucción puede estar mal

Un prompt es código que ejecuta otro agente. Puede tener bugs.

Caso real: un prompt afirmó *«el wamid no es PII y puede ir completo al log»*. El ejecutor lo
implementó tal cual, y **la review adversarial descubrió que el wamid lleva el teléfono del
cliente en base64**. El prompt habría metido PII en los logs de producción.

Por eso **todo programa lleva una cláusula que autoriza a desobedecer**:

> Si al seguir literalmente algo que dice este documento te encontrás quitando una validación,
> ensanchando un permiso, relajando un guard o dejando pasar un dato sin verificar: **la
> instrucción está mal, no el guard.** Paralo, explicá cuál es el agujero, y proponé la
> alternativa. Cumplir al pie de la letra no es una defensa.

Escribila siempre. Es la que salva cuando te equivocás.

## Estructura del prompt

Ocho secciones. No se saltan ni se reordenan.

### 1. Encuadre
Qué es el sistema, qué superficie y qué tenant toca esta fase, y **qué NO entra en el alcance**.
El alcance negativo es tan importante como el positivo: este proyecto se rompe por cambios
oportunistas, no por cambios insuficientes.

Incluí acá los hechos ya establecidos con su evidencia, y **prohibí explícitamente
re-litigarlos**. Si la auditoría ya refutó una premisa, el ejecutor no la vuelve a discutir: la
trata como hecho y corrige el comentario del código que la afirmaba.

### 2. Contrato de trabajo
Cuatro cláusulas, redactadas como condiciones de aceptación verificables:

- **Disciplina de alcance** — la lista COMPLETA de archivos que el programa puede modificar.
  Cualquier otro archivo significa que encontró algo fuera de alcance: **parar, reportar, no
  arreglar**.
- **Control continuo de regresión** — no se acumulan cambios para verificar al final. Después de
  cada etapa, correr lo que cubre esa superficie. RED-first siempre que se agregue comportamiento.
- **Una instrucción jamás justifica abrir un agujero** — la cláusula de la regla uno.
- **Backend no cambia frontend** (o viceversa), con evidencia verificable:
  `git diff --stat -- <ruta del panel>` debe salir vacío y se reporta.

### 3. Fase 0 — auditoría obligatoria
Preguntas concretas que hay que responder **con `archivo:línea`** antes de escribir nada.
Prohibición explícita de modificar durante esta fase.

Marcá cuál de las preguntas es la más importante, y por qué. Ejemplo real: *«¿en qué casos
legítimos puede NO existir `users/{uid}`? Esta es la pregunta más importante del programa: el
fail-closed no puede romper el bootstrap del admin.»*

### 4. Estado de partida verificable
Los hechos que el programa da por ciertos **con su fuente**, y separado, lo que hay que
**reverificar contra producción**. Todo lo marcado `⚠️ verificar` va acá.

### 5. Requisitos, cada uno con su invariante
Por cada requisito, el invariante que no se puede violar: fail-closed, idempotencia, aislamiento
multi-tenant, la IA jamás decide dinero, ningún camino mueve un pedido sin autorización humana,
cero hard-delete, privacidad.

**Señalá el punto exacto donde el arreglo puede introducir un defecto nuevo.** Es el patrón que
más veces mordió a este proyecto: el guard de silencio que ensanchó una ventana de cero E/S, el
mapa vacío con merge que borró el resumen del cliente, el test nuevo que pasaba vacuo.

### 6. Riesgos y condición de parada fail-closed
En qué situación la sesión **debe detenerse sin mutar nada** y pedir decisión del owner.

Detenerse fail-closed es un resultado correcto, no un fracaso. Este proyecto se detuvo así en el
preflight del Programa 2 y estuvo bien. Escribilo con esas palabras.

### 7. Verificación exigida
**En números, no en adjetivos.** «Tests en verde» no es criterio; «E2E verify-attachments 98/98
en dos corridas desde emulador limpio» sí.

Incluí las trampas verificadas del repo que apliquen (ver §Trampas). Y si el cambio toca dinero,
pedidos, pagos, privacidad, multi-tenant, deploy o rollback: **review adversarial obligatoria**,
con el foco explícito de qué buscar.

### 8. Cierre
`/cerrar-fase NOMBRE-DEL-PROGRAMA-N`, los 9 campos, y una **frase final exacta** que el ejecutor
debe emitir. La frase funciona como contrato de cierre y hace evidente si el programa terminó.

## Cómo verificar el reporte que devuelve

**No le creas al reporte: corroboralo contra el código.** Un reporte honesto resiste; uno inflado
no. Qué mirar, en orden:

1. **Lo verificable primero** — commit, archivos tocados, que la whitelist se haya respetado, que
   el panel no haya cambiado si era backend puro.
2. **El defecto que introdujo el propio arreglo.** Es el hallazgo de mayor valor. Si el fix quitó
   un guard, seguilo hasta el final y confirmá que el bloqueo sigue existiendo en otro lado.
3. **Los tests que se modificaron.** Un test invertido puede ser honesto (la aserción vieja fijaba
   el defecto) o puede ser una regresión escondida. Leé el diff: ¿la aserción nueva es más fuerte
   o más débil? Un test que pasa de una aserción a tres, con el motivo documentado en el lugar, es
   correcto. Uno que afloja un `expect` para que pase, no.
4. **Checks que no se ejecutan** — tsconfig que excluye los `.test.ts`, asserts contra conjuntos
   vacíos, suites que ningún script invoca, comandos que no existen en la versión instalada.
5. **Los números que no re-verificaste** — marcalos como «reportado, no re-verificado en esta
   sesión». Nunca los repitas como propios.

Si no encontrás nada, **decilo derecho** en vez de inventar hallazgos menores para justificar la
revisión.

## Honestidad de estado

Tres estados que jamás se mezclan:

- **EN REPO — NO DESPLEGADO**: el código existe y está probado; producción no lo tiene.
- **EN PROD — INERTE**: desplegado con el flag apagado. Desplegado ≠ activo.
- **EN PROD — ACTIVO**: desplegado, encendido y con smoke real aprobado.

Nunca declares una fase «completa» porque los tests pasan. Completa significa validada en
producción con evidencia. Si se probó en emulador y no en prod, se dice así con esas palabras.

## Invariantes que jamás proponés violar

- La IA describe y recomienda; **jamás decide dinero** ni confirma un pago.
- Ningún camino automático mueve un pedido sin autorización humana explícita.
- Fail-closed en todo interruptor: ausente, `false`, `"true"`, `1` y cualquier forma que no sea el
  booleano exacto `true` significan APAGADO. Un error de lectura también apaga.
- Aislamiento multi-tenant estricto.
- Cero hard-delete de pedidos, mensajes, adjuntos, auditoría o evidencia financiera.
- Nada de hardcodear un tenant ni un rubro en el backend.
- **No se despliega sin aprobación explícita del owner. Nunca.**

## Trampas verificadas de este repo

Incluilas en el prompt cuando apliquen:

- `cmd | grep` **enmascara exit codes**: usar PIPESTATUS o archivos.
- PATH: `export PATH="/c/Users/nicog/AppData/Local/Programs/VendeYaPy/node20:$PATH"` antes de
  node/pnpm (el default trae Node 24; el proyecto exige Node 20).
- CLI de Firebase del repo: `10-backend/node_modules/.bin/firebase`.
- E2E: `--project demo-aiafg` + `seed-users.mjs` + `load-catalog.mjs` **dentro del mismo `exec`**.
  Sin catálogo, `verify-human-handoff` falla 5/11.
- En Windows el string del `exec` corre con cmd.exe: `VAR=x cmd` **no funciona**; exportar en el
  proceso padre.
- `--only functions` sin selector **crea en producción** funciones que no deben existir.
- El selector de rollback es **el mismo menos las CREATE**: si incluís una CREATE, el deploy
  aborta el comando entero.
- `hosting:rollback` **no existe**; el comando real es `hosting:clone`.
- Un rollback de functions **no frena los schedulers**: se pausan aparte.
- Los `.test.ts` **no se typechequean** (tsconfig los excluye, vitest no tiene `typecheck`).
- **Cero CI**: nada obliga a correr la batería. Por eso se exigen exit codes reales.

## Un identificador puede ser PII aunque no lo parezca

El wamid de WhatsApp lleva el teléfono en base64. Antes de autorizar que un identificador vaya
completo a un log, **decodificalo y miralo**. Si no podés verificarlo, que vaya enmascarado.

## Al entregar

El prompt va en **un solo bloque copiable**, sin comentarios alrededor. Después del bloque, como
máximo tres líneas: qué asumiste, qué no pudiste verificar, y qué decisión necesita el owner
antes de arrancar.
