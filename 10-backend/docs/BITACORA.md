# BITÁCORA — VendeYaPy

Registro **append-only**. Una entrada por programa, la más reciente arriba. Nada se edita ni
se borra: si un hecho se supera, se agrega una entrada nueva y la vieja se marca
`[HISTÓRICO — superado por <entrada>]`. El presente vive en `ESTADO.md`.

---

## Plantilla

```markdown
### NOMBRE-DEL-PROGRAMA-N — AAAA-MM-DD (EN REPO — NO DESPLEGADO | EN PROD — INERTE | EN PROD — ACTIVO)

**Qué hace.** Una o dos frases. Qué problema resuelve, no qué archivos toca.

**Causa raíz.** Por qué existía el problema. Si el programa destapó defectos ajenos, van acá,
cada uno con su severidad (ALTO/MEDIO/BAJO) y si quedó abierto o cerrado.

**Verificación.** Números reales: typecheck, lint, tests por paquete, E2E por suite,
review adversarial (cuántos hallazgos, de qué severidad, todos corregidos o no).
Distinguir explícitamente lo probado en emulador de lo probado en producción.

**Selector del release.** CREATE / UPDATE / DELETE con nombres, orden de deploy
(consumidores primero, productores último), índices, Rules, Hosting.
**Orden de rollback:** el inverso y SIN las CREATE.

**Commit.** `hash`

**Estado real.** Qué quedó desplegado, qué quedó inerte, qué flags, en qué tenants.
Qué NO valida esta entrada.

**Deudas y limitaciones conocidas.** Declaradas, no escondidas.
```

Reglas de escritura:

- Un número sin fuente no se escribe. Si no se verificó en la sesión, va `⚠️ verificar`.
- "Desplegado" nunca implica "activo". Si el flag está apagado, la entrada lo dice.
- Las limitaciones conocidas son parte obligatoria de la entrada, no un apéndice opcional.

---

## 2026-08

### CRITICAL-FIX-PANEL-SILENT-SAVE-1 — 2026-08-20 (EN REPO — NO DESPLEGADO)

Arreglo del CRÍTICO **H-03** y de **H-15 + H-38 + H-39**: el panel ejecutaba mutaciones que, si
el backend rechazaba, **no decían nada** —el botón volvía de «Guardando…» a «Guardar cambios»
como si hubiera salido bien— y varias pantallas afirmaban «no hay nada» cuando en realidad la
lectura había fallado. La config del agente es *cómo vende el bot*: el dueño quedaba operando
sobre una creencia falsa, y al recargar su trabajo volvía al texto anterior.

**Causa raíz.** Ninguna de esas mutaciones tenía `onError` ni renderizaba `isError`, y los
estados vacíos se calculaban con `data ?? []` / `?? 0`: con la lectura caída, `undefined` se
volvía cero y la UI lo mostraba como «vacío». Dos formas distintas de la misma cosa — la
pantalla afirmando algo que nunca verificó.

**Qué hace ahora.** Nueve pantallas (`agent`, `promotions`, `decisions`, `ads`, `followups`,
`tracking`, `replies`, `welcome`, `onboarding`) dicen el resultado de cada acción con el motivo
real del backend (`friendlyJobError` conserva el `message` de `invalid-argument` y
`failed-precondition`), y una lectura fallida se declara en vez de disfrazarse de vacío. El
componente nuevo `components/ui/EstadoDeAccion.tsx` es **presentacional puro**: se descartó a
propósito un hook genérico de mutaciones, que habría cambiado el comportamiento de ~30
mutaciones del panel de una sola vez. RED-first: la batería final (10 archivos, 61 tests)
corrida contra el código original —`git stash` de las 9 pantallas, medido al cierre— da **37
fallando y 24 pasando**; los que pasan son los casos NO-REGRESIÓN, que por definición deben pasar
antes y después.

**Review adversarial (CINCO pasadas, revisor fresco cada una):** 8 + 9 + 8 + 10 + 8 hallazgos,
**todos corregidos**. Cada pasada revisó las correcciones de la anterior; las cuatro primeras
encontraron algo bloqueante —incluidas tres regresiones que el propio fix había introducido— y la
quinta cerró **sin bloqueantes**. Primera pasada: 2 BLOQUEANTES + 2 ALTOS + 2 MEDIOS + 2 BAJOS.
(1) 🚨 El aviso quedaba **debajo del modal**: `PromoForm`, `ReplyForm`, `TrackingForm` y el
`ConfirmModal` de borrado son overlays `fixed inset-0 z-50`, así que para el escenario insignia
de H-03 —«llené el formulario y el backend lo rechazó»— la pantalla seguía muda… con un test
verde certificándolo, porque happy-dom no calcula stacking ni scroll. El error ahora viaja como
prop y se pinta adentro del modal (`ConfirmModal` ya tenía `error?: string | null` sin usar).
(2) 🚨 `auditStatusMut` de `/agent` seguía sin rama de error: «Resuelto»/«Descartar» rebotaban
en silencio. (3) Los avisos no se limpiaban al **cambiar de empresa** (`setTenantId` no remonta
la pantalla) ⇒ un error de la Empresa A colgado sobre los datos de la B. (4) El error del
formulario sobrevivía a cerrar y reabrir el modal. (5) `syncAds`, `computeAttribution` y
`generateInsights` van por endpoints `dev*` con `fetch` **sin chequear `res.ok`**: un 404/500
disparaba `onSuccess`, así que el fix pasaba de mudo a **afirmar en verde** algo que no ocurrió
— reescritos como pedido («Pedimos la sincronización…»), no como resultado. (6) El componente
faltaba en el barrel `components/ui`. (7) La live region del éxito se montaba junto con su
texto (un `role="status"` recién insertado no se anuncia de forma confiable): ahora está siempre
montada y solo cambia el contenido. (8) Nadie mueve el foco al aviso — **queda como deuda**.

**Segunda pasada (sobre las correcciones):** 3 ALTOS + 4 MEDIOS + 2 BAJOS, todos corregidos.
(1) 🚨 **Pérdida de datos**: en `/agent` se había cubierto `auditsQ.isError` pero **no**
`agentQ`/`checkoutQ` — con la lectura caída el formulario muestra `DEFAULT_AGENT` con bancos y
vendedores vacíos, y «Guardar cambios» **pisaba la configuración real y borraba los datos de
cobro**. Ahora se avisa y el botón queda deshabilitado. (2) El error del modal tenía un **único
canal**: «Cancelar» no estaba deshabilitado mientras guarda y el `ConfirmModal` cerraba por click
en el fondo sin mirar `pending`, así que el rechazo podía llegar con el modal ya desmontado ⇒
silencio, H-03 otra vez. Cerrado por tres lados: botón deshabilitado, guard en el scrim (el
Escape ya lo tenía) y fallback del aviso al cuerpo de la página. (3) `openFromInsight` era la
única de las tres puertas del formulario sin limpiar el error previo. (4) **Violación del
contrato detectada por la review**: `onSuccess: invalidate` devolvía la promesa y react-query la
**esperaba**; al reescribirlo con cuerpo de bloque, `isPending` caía antes del refetch en **13
mutaciones** y el botón de un job medido por cuota se rehabilitaba de más. Restaurado con
`async/await`. (5) En `/welcome` el aviso de «Ir al panel» había quedado dos secciones arriba del
botón — la misma patología del bloqueante anterior, invertida. (6) H-15 incompleto en las
sugerencias de `/promotions`; (7) un job sin mensaje de éxito; (8) orden de declaración; (9) dos
afirmaciones inexactas en esta misma documentación, corregidas.

**Tercera pasada (sobre esas correcciones):** 2 ALTOS + 3 MEDIOS + 3 BAJOS, todos corregidos.
(1) 🚨 La pérdida de datos de `/agent` **seguía abierta por la ventana de carga**: el gate miraba
solo `agentQ.isLoading`, así que entre que aterrizaba una lectura y la otra el formulario se
renderizaba con `banks`/`sellers` vacíos y el botón HABILITADO — y con el `retry: 3` por defecto
del panel esa ventana dura segundos, no milisegundos. El gate ahora cubre las dos lecturas y el
botón exige `isSuccess` de ambas. (2) 🚨 El `ConfirmModal` compartido deja «Cancelar» habilitado
durante la acción: cancelar el borrado con la mutación en vuelo dejaba el rechazo en un estado
que nadie renderizaba ⇒ H-03 otra vez, en el programa que existe para matarlo. Ahora **todos**
los avisos huérfanos caen al cuerpo de la página. (3) **Regresión propia revertida**: deshabilitar
«Cancelar» en los tres formularios propios los dejaba **sin ninguna salida** —no tienen Escape ni
cierre por el fondo— hasta el timeout del callable (70 s). El diseño correcto es el inverso.
(4) El éxito se leía **dos veces** con lector de pantalla: `sr-only` oculta a la vista pero no del
árbol de accesibilidad ⇒ la copia visible va `aria-hidden`. (5) H-15 a medias en `/onboarding`:
los pasos cuya lectura falló se contaban como pendientes; ahora se marcan «no pudimos verificar
este paso» y salen del progreso. (6) Un test certificaba en verde una rama muerta; reescrito para
ejercitar el camino real. (7-8) Avisos rancios entre acciones y copy redundante.

**Cuarta pasada:** 2 ALTOS + 3 MEDIOS + 5 BAJOS, todos corregidos. Los dos primeros son de
react-query leído a fondo, no de lógica de pantalla. (1) 🚨 `isError` **no significa «no tengo
datos»**: un refetch en background que falla deja `status:'error'` conservando `data`. Y este
mismo guardado invalida las dos queries de `/agent` ⇒ un hipo de red después de guardar bien
pintaba el cartel rojo acusando al dueño de estar por destruir sus datos de cobro, **bloqueaba el
botón** y le ofrecía como salida «recargá la página», que es justo lo que le borra el trabajo.
Ahora se distingue el error que dejó la pantalla SIN datos (`isLoadingError`) y guardar solo
exige que los datos existan. (2) 🚨 En `/replies` y `/tracking` un mensaje de **éxito anterior
tapaba** el rechazo huérfano: caja verde sobre un guardado que había fallado. El rechazo ahora
tiene prioridad. (3) **Sin conexión** la query queda `pending+paused`: ni `isLoading`, ni
`isError`, ni `isSuccess` ⇒ las secciones quedaban **en blanco** y `/agent` con el botón muerto y
mudo. Se agregó `lib/lectura.ts` (helper puro) para decir las dos cosas —error real y falta de
conexión— igual en las nueve pantallas. (4) Sin `key`, pasar de éxito a error reutilizaba el
mismo nodo: el `role="alert"` se le agregaba a un elemento ya montado y **no se anunciaba**.
(5) El progreso de `/onboarding` podía llegar a **100 % con 1 de 4 pasos leídos**; ahora, con
pasos sin verificar, no se muestra la barra. (6) **Se revirtió el guard del scrim del
`ConfirmModal`**: era un cambio en un componente compartido por 12+ pantallas ajenas al programa,
y con el aviso huérfano cayendo al cuerpo ya no hacía falta. (7-10) Prefijos en los errores de los
endpoints `dev*` (solo pueden fallar con un error de red crudo), «No hay productos» sobre una
lectura caída, y copy.

**Quinta pasada:** veredicto **sin bloqueantes**, con 2 MEDIOS y 6 BAJOS igualmente corregidos.
El principal era otra **regresión propia**: `/onboarding` no tenía gate de carga, así que en el
primer render las cuatro lecturas están vacías y la pantalla de bienvenida del dueño nuevo
mostraba **cinco mensajes rojos de «no pudimos verificar»** — cargar no es fallar. También:
`isPaused` convive con datos ya cargados (un refetch por foco sin red), así que el aviso solo sale
si la pantalla quedó **sin** datos; en `/decisions` y `/followups` la falla de lectura vivía en el
subtítulo gris, indistinguible del texto que reemplazaba, y ahora se dice en rojo como `alert`
como en las otras siete; y dos afirmaciones de esta misma bitácora estaban desactualizadas
respecto del código.

**Verificación.** `pnpm -r typecheck` **exit 0**; `pnpm --filter web lint` **exit 0** (sin
warnings); `pnpm --filter web test` **57 archivos / 756 tests, exit 0** (61 de ellos nuevos, en
10 archivos: los 9 de pantalla más el contrato de accesibilidad del componente); `pnpm --filter web build` **exit 0**; `git diff --check` **exit 0**. **Cero
backend**, evidenciado: `git diff --stat -- apps/functions packages` **vacío** ⇒ los E2E de
backend no aplican y no se corrieron. En navegador contra emuladores: con **7.200 caracteres**
en «Reglas de venta» el 400 real produjo «No se pudo guardar la configuración. Campo
"salesRules" demasiado largo.» y los 7.200 caracteres del dueño **siguieron en el formulario**
(el prefijo se cambió después a «No se pudo guardar todo.» por el hallazgo (j) de la cuarta
review —son dos escrituras y la primera puede haber salido bien—; el motivo del backend, que es
lo que se estaba verificando, viaja igual); en
`/promotions`, un nombre de 250 caracteres produce «Campo "name" demasiado largo.». Sin
desbordes horizontales ni texto cortado a **1440 / 1024 / 375 px** (medido antes de mover el
aviso al interior de los modales). Tras esa corrección se verificó en vivo la propiedad que los
tests no pueden ver: el aviso queda **dentro del `<form>` del modal** —o sea, dentro del mismo
overlay `fixed inset-0 z-50`— y no detrás de él. **Lo que NO se verificó en navegador:** la rama de lectura fallida — el SDK de Firestore en el panel no devolvió error con
un rol sin permiso (las Rules sí se aplican: el mismo GET por REST con token de SELLER da 403),
y forzarlo habría requerido tocar Rules, prohibido por el programa. Esa rama queda cubierta por
los tests, no por evidencia en vivo.

**Selector del release.** Ninguno de backend: 0 CREATE / 0 UPDATE / 0 DELETE, 0 índices, 0
Rules, 0 TTL. Es **solo Hosting** ⇒ viaja en el **Tramo 2**, no en el Tramo 1 (a diferencia de
H-01 y H-02). Rollback = `hosting:clone <site>@<versionId> <site>:live` (`hosting:rollback` no
existe en firebase-tools).

**Commit.** `6882740`

**Estado real.** EN REPO — NO DESPLEGADO. **Producción sigue con el defecto**: hoy, si el
backend rechaza una configuración del agente, el panel no lo dice y el dueño pierde el trabajo
al recargar. El Hosting está **congelado** por la App Review de Meta en curso.

**Deudas y limitaciones conocidas.** (a) El mismo patrón sigue vivo fuera del alcance:
`/simulator` (5 mutaciones, 0 con rama de error), `/catalog`, `NotificationBell`,
`MetaReconciliation`, `OutboxIncidents`, `CustomerInfoPanel`, `LinkClientModal`,
`CoexistenceHistoryCard`, `WhatsappActivationQueue`. (b) H-15 vivo en el **dashboard**: si
fallan las métricas, los KPIs quedan como esqueleto animado para siempre. (c) Los tres mensajes
configurables de `/agent` (`fallbackMessage`, `handoffMessage`, `farewellMessage`) se guardan y
**el motor no los usa** — config muerta, programa propio. (d) La cura de fondo de los endpoints
`dev*` (`if (!res.ok) throw`) cambia cuándo dispara `onSuccess`: fuera del contrato de este
programa. (e) El foco no se mueve al aviso de error. (g) La limpieza por cambio de
empresa está en 8 pantallas: `/welcome` no la lleva porque no tiene selector de empresa.
(h) El error del `ConfirmModal` se pinta con su propio `<p>`, no con `EstadoDeAccion`: unificarlo
cambiaría el estilo de las otras seis pantallas que ya lo usan, así que queda fuera de alcance. (f) Los `<label>` de los formularios del
panel no están asociados a sus inputs (sin `htmlFor`/`id`), detectado al escribir los tests.
(i) Los mensajes de éxito de `/promotions`, `/replies` y `/tracking` no caducan solos (el de
`/agent` sí, a los 2,5 s). (j) `saveMut` de `/agent` son dos escrituras secuenciales: si la
segunda falla, la primera ya se guardó — el texto dice «No se pudo guardar todo», que es cierto
pero no precisa cuál. (k) Ninguno de los tres formularios propios del panel tiene Escape ni
cierre por el fondo (por eso «Cancelar» no puede bloquearse).

### CRITICAL-FIX-USER-CLAIMS-1 — 2026-08-19 (EN REPO — NO DESPLEGADO)

Arreglo del CRÍTICO **H-02**: `inviteUser` resolvía el uid por email y escribía
`setCustomUserClaims` sobre un usuario de otra empresa sin validar nada, y `assertSameTenant`
era fail-open (sin doc `users/{uid}` no lanzaba — justo el caso del PLATFORM_ADMIN, cuyo
bootstrap no crea ese documento). Un owner secuestraba al owner ajeno, degradaba al admin de
plataforma y, con `setUserActive`, le deshabilitaba la cuenta. RED-first: 4 tests fallando por
el motivo correcto («promise resolved instead of rejecting»).

**Fix:** `assertDestinoOperable` fail-closed —siguiendo el patrón de `conversation/lifecycle.ts`
(mensaje único anti-enumeración)— llamado también desde `inviteUser` cuando el email ya existía.
Sólo se opera sobre un destino que declare ESTA empresa. `setUserActive` conserva el permiso de
tocar a un DISABLED (es la operación que lo reactiva; bloquearlo dejaba las bajas
irrecuperables — detectado y cerrado durante la implementación).

**Review adversarial:** 1 ALTO + 1 MEDIO + 3 menores, corregidos: (1) una cuenta **huérfana** de
Auth ya no es adoptable — el registro crea la cuenta antes de verificar el mail, así que toda
persona entre «me registré» y «verifiqué» era secuestrable (mismo defecto, otras víctimas); el
caso legítimo de invitación a medio camino queda cubierto por la rama de claims; (2)
`setUserRole`/`setUserActive` escribían docs SIN `tenantId`, lo que dejaba al usuario intocable
para todos los tenants —incluido el admin— para siempre: ahora escriben `tenantId` y el guard
tolera el doc parcial cayendo a los claims; (3) las dos lecturas ocurren siempre, para cerrar el
canal lateral por latencia. Sin CRÍTICO introducido. Verificado que **no hay otro camino
explotable por un owner** que escriba claims (`provision.ts` es PLATFORM_ADMIN-only,
`registerTenantOwner` es self-only con triple barrera).

**Deuda abierta declarada** (programa aparte): `inviteUser` sigue revelando si un email existe
(`created: true|false`), sin audit del rechazo ni rate-limit ⇒ enumeración del padrón. La cura
de fondo es la invitación con aceptación del invitado.

**Verificación:** typecheck/lint/build/diff-check en 0; monorepo completo **verde**
(`apps/functions` 226 archivos / 3458 tests, web 695/695, shared 341/341); `src/users` 18/18;
E2E `verify-entitlements` 12/12 y `verify-fase4` **10/14 — los 4 rojos son preexistentes**
(planes del SaaS y billing: verificados idénticos en la base sin este diff; ningún seed del repo
crea `plans`), y sus checks de usuarios (7 «Owner invita un vendedor» y 8 «rol + tenant
correctos») **pasan con el fix**. Panel sin cambios. En esta corrida el flake de
`coexistenceConnect` no apareció, lo que confirma su intermitencia.

### CRITICAL-FIX-WEBHOOK-INBOUND-DURABILITY-1 — 2026-08-19 (EN REPO — NO DESPLEGADO)

Arreglo del CRÍTICO **H-01**: el webhook respondía `200 {ok:true}` cuando fallaba la escritura
de un evento vivo al inbox ⇒ Meta no reintentaba ⇒ el mensaje del cliente desaparecía sin
rastro (y `written:0` era indistinguible de un lote vacío). RED-first: 10 tests nuevos fallando
por el motivo correcto («expected 200 not to be 200») antes de tocar el código.

**Qué hace ahora:** tráfico vivo sin persistir por fallo **transitorio** (gRPC 4/8/10/13/14, o
error sin código) ⇒ **503 + `retry:true`**; fallo **permanente** (7 PERMISSION_DENIED, 3
INVALID_ARGUMENT…) ⇒ 200 + log «requiere intervención», porque insistir no lo arregla y el
bucle degradaría la salud del webhook con la App Review en curso. `liveWriteFailures` en el
resumen; `catch` general que decide por contadores (o por el cuerpo crudo si la excepción fue
antes de planificar) y que ahora **también** protege el archivo de Coexistence; entrante sin
wamid con clave estable (hash del contenido) para que la redelivery no lo duplique;
`traeTraficoVivoCrudo` cubre IG/Messenger (`entry[].messaging`) y excluye el history-media.
Se corrigió el comentario que justificaba el 200 con dos premisas que la auditoría había
refutado.

**Review adversarial (obligatoria, revisor fresco):** 2 ALTOS + 3 MEDIOS + 2 BAJOS, todos
corregidos. El más importante: **el wamid ES PII** — lleva el teléfono en base64
(`Buffer.from('HBgMNTk1OTkxMjM0NTY3','base64')` ⇒ `\x1c\x18\x0c595991234567`), verificado
empíricamente; iba completo al log y el test lo certificaba como seguro **por accidente**. Ahora
va enmascarado y el test verifica también la forma codificada. Sin duplicación comercial
reproducible ⇒ no se disparó la condición de parada.

**Verificación:** typecheck/lint/build/diff-check en 0; `apps/functions` 3439/3440 y suite meta
102 archivos/1761 tests; E2E en emuladores limpios: conversaciones 42/42, human-handoff 11/11,
handoff2 8/8, ai-reservation 14/14; panel sin cambios (`git diff --stat apps/web` vacío). El
único rojo de la corrida completa es un **flake preexistente** (`coexistenceConnect.test.ts`
REPLAY), verificado en el commit base SIN este diff — documentado en ESTADO, no arreglado
(fuera de alcance).

**Deploy:** sale con el Paso 1 del Tramo 1 ya calculado; no necesita deploy propio.

### SYSTEM-AUDIT-SECURITY-ACTIONS-UI-1 — 2026-08-19 (AUDITORÍA — CERO FIX, CERO DEPLOY)

Inventario completo del sistema en `docs/system-audit-2026-08.md`: **56 hallazgos (3 CRÍTICOS,
15 ALTOS, 17 MEDIOS, 21 BAJOS/INFO)** de seis auditorías con foco disjunto (autorización y
multi-tenant, dinero/pedidos/pagos, prompt injection y frontera de IA, fallas silenciosas del
backend, huecos de UI verificados en navegador con captura de red, y secretos/PII/datos leídos
read-only de prod). Método: refutación antes de reporte; cada hallazgo con `archivo:línea` y
reproducción (tests vitest temporales, borrados; nada mutó producción).

**CRÍTICOS:** H-01 el webhook ACKea 200 a Meta cuando falla la escritura del inbox y el mensaje
del cliente se pierde sin rastro (la redelivery se probó idempotente: la justificación escrita
en el código no se sostiene); H-02 `inviteUser` reescribe claims de cualquier usuario por email
(secuestro de owner ajeno + degradación del PLATFORM_ADMIN; `assertSameTenant` fail-open y ni
se llama); H-03 el guardado del agente y de promociones pierde el trabajo en silencio ante un
400. **Confirmación cruzada:** dos agentes independientes llegaron a `confirmPayment` no
atómico (H-05) y al aviso de pago que nadie envía (H-06).

**Lo que aguantó, verificado:** aislamiento de tenant en callables y Rules; la IA no fabrica
precios/SKUs ni mueve dinero; el caption jamás llega al modelo (atacado por seis rutas); cero
hard-delete de pedidos/pagos/comprobantes/auditoría; URLs firmadas nunca persistidas; los 22
`dev*` devuelven 404 real en prod; un owner no puede auto-mejorarse el plan.

**Cero fix aplicado** (es el contrato del programa): el ranking priorizado de correctivos está
en §3 del informe. Verificación: `pnpm -r typecheck/lint/build` en 0 (solo se agregó
documentación); E2E no corresponde. Repo intacto salvo los tres documentos.

### PRE-RELEASE-HOSTING-KEYS-AND-HANDOFF-STATE-1 — 2026-08-19 (DOCS + VERIFICACIÓN — CERO DEPLOY)

**(A) Claves de Hosting corregidas — el defecto habría dejado el panel sin conexión de Meta.**
HANDOFF §5 decía «9 claves obligatorias»; la plantilla real tiene 13 y el código usa una 14ª
(`NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID`, solo en `.env.example`). Verificado en CÓDIGO (no
en comentarios): sin `META_APP_ID`/`META_CONFIG_ID`, `readConfig` ⇒ null
(`metaEmbeddedSignup.ts:129-135`) e Integraciones queda en «Meta no configurada» sin OAuth
real (matiz vs el enunciado del programa: en build de PROD no cae a devMetaConnect — el modo
demo es por entorno, `integrations.ts:90`; la consecuencia es la misma: nadie conecta su
número); Coexistence jamás cae al config estándar (:127). Corregido: HANDOFF §5 (lista de 14
con consecuencia por clave + smoke ampliado que verifica la PRESENCIA de los config_id en los
chunks), `.env.production.example` (+COEXISTENCE con comentario), plan §6/§9 (dos menciones).
Cero valores reales al repo.

**(B) Set de estados del release: COMPLETO con dos — cero código tocado.** Evidencia por
estado: `Session.cart` (session.types.ts:84) NO se toca al liberar y «carrito»/«pagar» son
reglas del pipeline global previas a la máquina (engine.ts:335-336,458) ⇒ CART solo pierde
posición conversacional (el reinicio de navegación documentado como buscado, handoff.ts:322);
`CHECKOUT_DONE` sin lectores (solo lo escribe confirmPayment.ts:71) y auto-transiciona a IDLE;
GREETING/BROWSING/VIEWING_PRODUCT = navegación (lastShownSkus sobrevive y la selección es
regla global); IDLE es el destino. Ampliar el set sería crecer el guard sin pérdida
demostrable (§2.3 del programa). Callers: chatRelease y devReleaseChat; nadie depende de IDLE.

**(C) Verdad del estado, con dato directo:** `chatRelease` en prod `updateTime`
2026-07-31T11:23Z < fix `4af6607` (2026-08-04) ⇒ fix EN REPO — NO DESPLEGADO; bloqueante de
ESTADO reescrito con la advertencia operativa para Fase 3 (no «devolver al asistente» durante
un pago hasta el deploy).

**Verificación:** typecheck/lint/build/test/diff-check con exit codes reales;
`git diff --stat -- 10-backend/apps/web/src` VACÍO (§2.4: panel sin cambios). E2E de handoff
no corridos: cero código de handoff tocado.

### APP-REVIEW-STATUS-AND-DEPLOY-WINDOW-1 — 2026-08-19 (READ-ONLY — CERO MUTACIÓN)

Evidencia para el GO/NO-GO del Tramo 1, en `release-plan-tres-programas.md` §10 (nueva).
Script nuevo `scripts/review-window-audit.mjs` (read-only, field mask — el texto de los
mensajes ni viaja; teléfonos enmascarados). **meta-review …686**: último inbound 15-08 ≈11:48
ASU (~4 días); ráfaga de 7 mensajes el 12-08 (mié 09 h) con 5 remitentes distintos — compatible
con revisores, no probatorio (el backend no distingue revisor de owner; limitación declarada);
3 en 7 días, 0 en 48 h ⇒ **no se puede declarar la revisión terminada**. **arfagi …904**: 57
inbound/30 d, todo 08:00–17:59 (+2 a las 22 h), **domingo con CERO mensajes en el mes** ⇒
ventana recomendada **domingo 05:00–07:30 ASU** (post verificación 04:30, pre tráfico/trials).
Graph API: NO expone el estado del App Review (dashboard-only); **cero llamadas a Meta, ni
GET**. Corrección al plan: el gate de App Review no es solo Hosting — el Tramo 1 redespliega
`metaWebhook`/`onWebhookInbox` (camino del revisor). **Recomendación: NO-GO hoy; GO
condicionado a la verificación del owner en el dashboard (§10.3) + ventana §10.4 + re-corrida
del script el día del deploy.** Verificación: typecheck/lint/build/diff-check en 0; E2E no
corresponde (programa de solo lectura y análisis).

### RELEASE-AUDIT-TRES-PROGRAMAS-1 — 2026-08-18 (READ-ONLY — CERO DEPLOY EJECUTADO)

Plan de release exacto y verificado de los tres programas EN REPO, en
`docs/release-plan-tres-programas.md`. **Base confirmada contra producción**: el `updateTime`
máximo de las 118 functions es 2026-08-16T00:35Z con exactamente 10 actualizadas ese día (las
de DEPLOY-AI-PHASE2 desde `6f75601`; nada posterior) ⇒ se corrigió
`release-audit.mjs:COMMIT_BASE_DESPLEGADO` `'30c1687'`→`'6f75601'` (único cambio de código).
**Audit con base corregida: veredicto OK, cero bloqueos** — 139 exports coincidentes
fuente/compilado, 0 divergencias de grafo, precondición `automationMode` aprobada (2/2),
contraste exacto 20 ausentes-en-prod == 20 CREATE.

**Hallazgos del cálculo**: (1) CREATE = 20, no 14 — el selector crudo incluye las **6
`coexistence*`** de la fundación EN REPO (Programa 2 bloqueado): el plan las EXCLUYE; (2)
UPDATE = **las 118** (sinCambio 0): `lib/firebase.ts` y `audit/audit.ts` son universales ⇒ el
release es un redeploy completo + 14 CREATE; (3) schedulers reales: **8**, no 7; (4) único
delta Firestore: TTL `metaOAuthStates` (3 ACTIVE en prod, repo declara 4); 21 índices READY ==
repo; cero Rules. **Backend-first APTO sin Hosting** (0 referencias del panel `6f75601` a las
14 CREATE; contratos consumidos aditivos; 3 divergencias de forma de error documentadas en
flujos hoy no ejercitados) ⇒ release en 2 tramos: backend (4 pasos ordenados) + Hosting
bloqueado por App Review. Rollback = los 118 UPDATE sin CREATEs; las 14 creadas quedan vivas e
inertes (callables auth-gated; retiro real = `functions:delete` con gate propio).

**Verificación**: typecheck/lint/build/diff-check en 0. Los tests
`tests/integration/release-audit.*.test.ts` que menciona el header del script **no existen**.
Deploy: NINGUNO — documento y constante solamente.

ADR-0022 sobre ADR-0015: eje declarado `catalogSync.relationship` (`none|mirror|managed`) con
derivación pura de autoridad (`vendeyapy|meta|external`; el bot siempre `local_mirror`). Legacy
sin backfills: arfagi ⇒ external+mirror, sin config ⇒ vendeyapy+none, `mode` no participa.
Transición preview→apply con planHash/TTL/uso único/huella `concurrent_change` y update mask
estricto (jamás `enabled`/`mode`/`catalogId`/`live`/opt-ins/deletes). Gating por relación en
todos los callables de Meta + schedulers (drain-only) + RBAC `catalogSyncApply` owner-only.
Panel con selector honesto, confirmación fuerte, frescura y edición consciente de campos
gobernados.

**Review adversarial:** 1 ALTO (zombis de outbox + deadlock de regreso) + 1 MEDIO (carrera de
encolado) + 6 BAJO — todos corregidos (sweep/discard siempre, re-derivación en la tx de encolado).
**Verificación:** batería en 0; E2E nuevo 23/23 + meta-catalog 194/194 + 4 regresiones verdes.
**Deploy futuro:** 2 CREATE + updates `metaCatalog*`/`runTenantJob`/schedulers + Hosting; sin
índices ni Rules.
**Deudas al conector:** selector de `catalogId`, URL directa, TTL de runs.

### CONVERSATIONS-WHATSAPP-UX-1 — 2026-08-18 (EN REPO — NO DESPLEGADO)

ADR-0021, bandeja profesional. Los recibos de Meta dejan de descartarse → `deliveryStatus`
monotónico transaccional por wamid (pending<sent<delivered<read, failed terminal temprano,
jamás inferir leído, cero costo de IA). `profileName` capturado. Media saliente
(`sendImage`/`sendDocument` + upload multipart + `conversationSendAttachment`: magic bytes,
allowlist, caption al documento — nunca a la IA, idempotencia con lease, jamás comprobante,
doble cerrojo). Guard de routing único para texto y media. 10 callables de ciclo de
vida/vínculo/búsqueda/asignación con matriz §7 y 9 audits. `softDelete` reversible sin borrado
físico. Panel reescrito (10 componentes, filtros, separadores, ticks accesibles, adjuntos,
borradores, info con teléfono enmascarado).

**Verificación:** RED-first; batería en 0; E2E nuevo 42/42 + 5 regresiones verdes; visual en
3 viewports con 3 hallazgos corregidos; review adversarial 0 ALTO, 1 MEDIO + 6 BAJO, todos
corregidos; P1-P3 documentados en el ADR.
**Deploy futuro:** 11 CREATE + updates de webhook/manualMessage/adjuntos + Hosting; sin
índices, Rules ni TTL.

### META-ONBOARDING-SELF-SERVICE-1 — 2026-08-17 (EN REPO — NO DESPLEGADO)

ADR-0020: lifecycle owner-facing consolidado, 11 gaps cerrados, cero sistema paralelo.
Selección de WABA con estado pendiente + `completeMetaConnectWaba`; verify/disconnect por
`connectionId` (incluidas `wa_*` para el owner); disconnect de main transaccional con secreto
compensable y retiro del pendiente huérfano; guard de WABA en el índice global en la misma tx;
rate-limit de nonces; TTL de `metaOAuthStates`; `meta.verified`/`meta.reconnected` con actor.
Panel completo: selector de WABA, confirmación fuerte, `lastConnectError` traducido, antigüedad
de verificación, acciones por número, a11y.

**Verificación:** rojo→verde por gap; fase4b 27/27 (sección AUTOSERVICIO) + 7 regresiones
verdes; review adversarial 1 MEDIO + 2 BAJO, todos corregidos.
**Deploy futuro:** 1 CREATE + updates de meta-connect + índices TTL + Hosting.
**Deuda:** scheduler de salud (G5).

### DEPLOY-AI-PHASE2-SALES-RESERVATION-1 — 2026-08-16Z (EN PROD — ACTIVO)

Fase 2 desplegada desde `6f75601`: 10 UPDATE / 0 CREATE / 0 DELETE (las 9 de soporte primero,
`onWebhookInbox` al final; `devMessage` excluida a propósito). Realiza el release de
AI-PHASE2-MATCHER-AND-RESERVATION-HARDENING-1.

**Smokes por wamid:** "hola" determinístico sin reserva ni `aiRequest`; consultivo con reserva
`ventas-{wamid}` estimada 9775 → liquidada real 3833, conciliación exacta, espejo en 0, una
sola respuesta. 117 functions intactas, `automationMode: live` ×2, visión AUSENTE ×3, meta-review
y credipower preservados, logs limpios.
**Rollback armado y conservado:** `bdaffbe` + `30c1687`.
**Deuda pre-activación de visión:** reconciliar el precio de Odyssey.

### AI-PHASE2-MATCHER-AND-RESERVATION-HARDENING-1 — 2026-08-15 (desplegado el 2026-08-16)

Matcher de identificación estructurado (`matched`/`ambiguous`/`no_match`, evidencia estructural
+ margen; conteo, posición y precio jamás identifican) reemplaza la decisión por conteo de
visión. Reserva contextual del sales agent (`estimarTurnoDeTexto`: chars/3 + rondas, piso 1500,
techo 16k, clamp al límite efectivo) reemplaza la estática de 1500 (real 3770).

**Causa raíz honesta del canary:** el guard de deriva excluía al ARMAF (conflicto de precio
pendiente del owner) — el matcher no era el único culpable.
**Review adversarial:** 0 ALTO / 3 MEDIO / 1 BAJO, todos corregidos.
**Selector:** 10 UPDATE + 0 CREATE + 0 DELETE (`onWebhookInbox` + las 9 de Fase 1c).

### WHATSAPP-AUTOMATIONMODE-DUAL-MIGRATION-AND-VISION-RECANARY-1 — 2026-08-15 (EN PROD)

Migración dual de `automationMode` → `live` con la herramienta oficial: …7904 (arfagi) y …5686
(meta-review) written; índice no tocado; conexiones byte-idénticas; rollback `--mode inactive`
documentado (equivalente fail-closed, no byte-idéntico: el campo nacía AUSENTE). ADC habilitada
por el owner tras un stop fail-closed. PNID de meta-review leído del índice tras un `not_found`
por reconstrucción de memoria.

**Checks del runbook:** dual 20/20 + coexistence 51/51.
**Re-canary de visión EXITOSO:** job `succeeded` + enviado, reserva liquidada 2507, espejo 0,
respuesta entregada por …7904, `sin_match` honesto (calibración del matcher pendiente).
Flag restaurado a AUSENTE; `live` se conserva. Fase 2 desbloqueada, pendiente de aprobación.

### AI-VISION-PROVIDER-CANARY-ARFAGI-1 — 2026-08-15 (BLOQUEANTE DOCUMENTADO — RESTAURADO)

Canary real de visión en arfagi: producer/job/claim/reserva (liquidada 2529)/extracción/catálogo
todo por contrato, cero duplicados ni efectos comerciales.
**Bloqueante hallado:** el `whatsappClient` del artefacto nuevo aplica el gate de ADR-0017 y
`automationMode` estaba AUSENTE en …7904 ⇒ envío bloqueado ⇒ `failed`/`envio_incierto`.
Kill-switch + flag restaurado a AUSENTE, verificado contra baseline.
**Precondición operativa aprendida:** liberar takeovers residuales del tester antes de un canary.

### DEPLOY-AI-RESERVATION-VISION-INERT-1 — 2026-08-15 (EN PROD — VISIÓN INERTE)

Deploy de ADR-0018 + ADR-0019 desde `bdaffbe`: índices 18→21 (3 `ai*` READY, 0 deletes), rules
`a9c99e05`→`132712ca` (0 quitadas, 6 matches `if false`, probes 403), Functions 115→118 con
selector exacto 3 CREATE + 6 UPDATE + 0 DELETE, sin `--force`. `onWebhookInbox` intacto
(updateTime 2026-08-01, hash idéntico en las 106 no tocadas). Rollback armado ANTES del deploy
(worktree `30c1687` + tooling HEAD; cubre las 6 UPDATE — el "4 UPDATE" del plan v1 estaba mal).

**Smoke humano:** reserva `ventas-…` creada→liquidada (est. 1500 / real 3770), espejo en 0,
delta conciliado al token exacto, cero efectos externos, meta-review intacto.
**Estado:** flag de visión APAGADO en los 3 tenants. Scheduler horario sin invoker público.

### AI-VISION-PRODUCER-DECOUPLE-1 — 2026-08-14 (EN REPO — NO DESPLEGADO)

Productor de visión desacoplado: trigger `onAiVisionProducer` sobre `inbox→processed`
(compatible con el `process.ts` productivo viejo); `process.ts` byte-idéntico a `855d553`;
clasificación estricta `generic_media`; discriminador `mediaId` sin timers; grafo probado en dos
pasadas (`onWebhookInbox` ya no alcanza visión). 16 tests + E2E 12/12 por el trigger real.

### AI-VISION-RELEASE-TRAIN-PREP-1 — 2026-08-14 (read-only)

Plan de release de ADR-0018/0019 en `docs/ai-vision-release-plan.md`. SEPARABLE: Fase 1
independiente (2 CREATE + 4 UPDATE sin el gate); Fase 2 (`onWebhookInbox`) bloqueada hasta
migrar `automationMode` de dos números. Cero deploy, cero mutaciones. Dos pasadas del grafo
coincidentes; App Review protegida por diseño del selector.

### PRODUCT-IMAGE-UNDERSTANDING-SAFE-1 — 2026-08-14 (desplegado inerte el 2026-08-15)

ADR-0019: visión de productos contra el catálogo local. Job durable idempotente por
`attachmentId`, claim+lease+fencing, envío único, reserva `imagen_vision` antes del proveedor,
tool forzada con zod (**la IA describe, jamás decide**), `searchCatalog` + guards como única
autoridad, comprobantes con precedencia absoluta, caption jamás al modelo, takeover = silencio.
28 tests núcleo con neutralización + E2E 11/11 con el trigger real del emulador. Activación
productiva = programa aparte.

### AI-USAGE-RESERVATION-AND-ALERTS-1 — 2026-08-14 (desplegado el 2026-08-15)

ADR-0018: reserva transaccional de cuota de IA — cierra AI-GATE-RESERVA-1 y AI-QUOTA-ALERTS-1.
Ciclo reservada→liquidada|liberada|vencida con clave determinística (wamid), contador espejo
`aiTokensReserved`, liquidación exactamente-una-vez con uso real (incluye parcial en error),
recuperación lazy + scheduler horario, alertas idempotentes 70/85/95/100 por campana.
12 casos discriminantes con neutralización demostrada + E2E 9/9 de concurrencia real.

### Programa 2 — Preflight del release de Coexistence — 2026-08-06 (DETENIDO FAIL-CLOSED)

Etapa A verde completa (batería + E2E + grafo de 122 exports, CREATE=6 / UPDATE=115 / DELETE=0)
y baseline productiva congelada read-only (un solo PNID, `automationMode` ausente =
`migracion_pendiente` esperado; credipower intacto). Runbook corregido con 6 precisiones
doc-only.
**Detenido antes de toda mutación:** 5 gates externos de Meta sin evidencia (incluida la
elegibilidad de Paraguay), `config_id` de Coexistence sin crear, ADC ausente en la máquina
(resuelto el 2026-08-15), y decisión v2/v3 pendiente del owner.

### Cierre correctivo final de Coexistence — 2026-08-05 (EN REPO — NO DESPLEGADO)

11 hallazgos de Codex Security + 8 de la review adversarial posterior, cerrados con test rojo
primero. El CRITICAL fue del propio correctivo anterior: un mapa vacío con merge **reemplaza**
en Firestore, y el guard monotónico borraba el resumen del cliente. Dos pasadas E2E completas
desde emuladores limpios (14 suites cada una). Cuatro pruebas externas diferidas al Programa 2
(contrato de timestamp, cardinalidad de WABA, prueba de offboarding, provenance de bundles),
resueltas fail-closed en código sin validación real.

### Correctivo Coexistence — 2026-08-04 (cierre del Programa 1, EN REPO)

Cerrados los 7 gates restantes: `live` real por herramienta (gate transicional retirado con
garantía estructural + E2E dual 20/20), IG/Messenger con canal propio, cutover transaccional con
rollback byte a byte (verify-cutover 22/22), UI humana del historial, generaciones del historial
(offboard cierra honesto; solo un signup nuevo abre la siguiente), backup de Storage con bytes +
restore aislado (backup-restore-e2e 51/51, exige los tres emuladores).

### Coexistence — fundación — 2026-08-04 (EN REPO — NO DESPLEGADO)

`automationMode: inactive|shadow|live` separa "la credencial sirve" de "el bot puede contestar",
fail-closed. Embedded Signup en dos flujos; el de Coexistence usa
`featureType = whatsapp_business_app_onboarding` y crea una conexión `wa_{pnid}` que jamás toca
`metaConnections/main`. El PNID se resuelve server-side desde el WABA porque el evento de cierre
oficial no lo trae. El historial hay que pedirlo (`smb_app_data`) y se pide UNA sola vez.
Número real no conectado, QR no ejecutado, backup productivo no ejecutado.

### RELEASE-SECURITY-AND-RUNBOOK-HARDEN-1 — 2026-08-03 (EN REPO — SIN DEPLOY)

Aislamiento de secretos por entorno, corregido en dos capas independientes. (1) `build-deploy.mjs`
copiaba cualquier `.env.<algo>` no-`.local` porque **no sabía a qué proyecto se desplegaba**:
ahora el destino es obligatorio y la allowlist es `.env` + `.env.<projectId>` +
`.env.<alias-que-resuelve-a-ese-projectId>`. (2) Los dos `firebase*.json` excluyen `.env*` del
zip. Probado con el walker real del CLI (13.35.1): 2191 y 874 archivos, cero `.env` subidos,
variables idénticas (10 prod / 8 staging).

**Hallazgos del runbook:** `hosting:rollback` NO EXISTE en ninguna de las dos versiones en juego
(el real es `hosting:clone`, con dos falsos positivos verificados); `gcloud` no está instalado
(el freno del scheduler va por REST); `pnpm deploy:rules` estaba hardcodeado a staging desde
`3939676` — falso positivo perfecto.
**Verificación:** typecheck 0, lint 0 errores, 2.956 tests, build 0, deploy-guard --audit 0.
**Exposición:** el bucket `gcf-v2-sources` no es público y los 4 secretos tienen valores
distintos por entorno ⇒ la fuga es interna y no alcanza a producción.
**Pendiente:** rotación NO ejecutada; 109 versiones vivas construidas con el `.env` de staging.

### Defectos que destapó el deploy de adjuntos — 2026-08-01/03

Seis, cada uno con programa propio, documentados en `docs/deploy.md` y `docs/HANDOFF.md`.
El más grave sigue abierto: **`releaseToBot` destruye el estado de checkout (ALTO)** — ver
`ESTADO.md`. Los otros cinco: fuga de secretos de staging (mitigada), `hosting:rollback`
inexistente, `deploy:rules` hardcodeado, el rollback no frena schedulers, y 4 secretos
productivos como env vars planas.

---

## 2026-07 y anterior — resumen

Entradas comprimidas. El detalle completo está en el resumen original de Codex
(`docs/_archive/codex-resumen-2026-08-18.md`).

- **`30c1687` — 2026-08-01/03 (EN PROD).** Adjuntos de conversación (ADR-0016): imágenes y PDF
  con ingesta endurecida, dos ejes ortogonales, rollout en dos niveles fail-closed
  (`attachments.ingest.enabled` + `receiptGate.enabled`), solo en arfagi. La ingesta **jamás**
  mueve un pedido. Visión y OCR diferidos. 115 ACTIVE, cero índices nuevos.
- **`d542cda` — 2026-07-31 (EN PROD).** Modelo de propiedad del catálogo por campos (ADR-0015);
  arfagi migrado a `external_managed`; primera reconciliación 50 `verified` / 131
  `drifted_external`. Resuelve el conflicto de fuente de verdad del 2026-07-30.
- **`6cfc464` — 2026-07-29 (EN PROD, dry-run).** Onboarding genérico de catálogos + centro de
  calidad (ADR-0014). Perfil `perfumeria` explícito de arfagi.
- **2026-07-30.** Importación genérica ejecutada: 150 artículos solo-en-Meta importados, 33→183
  productos, todos INACTIVE e invisibles para bot/carrito/checkout.
- **`fbb7aab` / `50793bc` — 2026-07-28 (EN PROD).** Preview binding y outbox de escrituras de
  catálogo, en dry-run inerte. Canary de Odyssey ejecutado y aprobado por el owner (única
  escritura a Meta de toda la historia del proyecto).
- **`eb28365` — 2026-07-25 (EN PROD).** Coverage GO-LIVE + PURGE-FIX-1: E2E real validado,
  Coverage reactivado solo en arfagi con activationId nuevo, `required`, máx ₲200.000.
- **`5f8ccbc` — 2026-07-24 (EN PROD).** Shipping Chat completo (ADR-0011): la IA jamás decide
  dinero; saga TX-A→claim→Meta→TX-C con el outbox como única fuente de verdad.
- **`0326784` — 2026-07-18 (EN PROD, flag OFF entonces).** Paquete Coverage con kill-switch
  atómico y contrato fail-closed `enabled + activationId`.
- **`1497b40` — 2026-07-16.** COVERAGE-GUARD-1: interceptor determinístico antes de la IA para
  consultas de cobertura, envío y plazos.
- **`855b00d` — 2026-07-16.** AI-FALLBACK-HONESTO-1: con la cuota agotada el bot deriva a un
  humano en vez de degradar en silencio.
- **`e0c284e` — 2026-07-15.** HANDOFF-2: pase real a una persona antes de la IA, transaccional
  e idempotente, con bot silencioso durante el takeover.
- **`97bb035` — 2026-07-15.** WHATSAPP-AGENT-F7: fidelidad estricta en consultas por producto
  y marca.
- **2026-07-15.** Incidente de cupo de IA (251.398 tokens vs límite de 250.000), mitigado;
  límite growth 250.000 → 1.500.000.
- **2026-07-13.** Migración de dominio: `vendeyapy.com` sirve producción con SSL.
