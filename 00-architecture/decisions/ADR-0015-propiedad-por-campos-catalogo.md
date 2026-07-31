# ADR-0015 — Propiedad por campos del catálogo y estado de sincronización honesto

- **Estado:** aceptado y DESPLEGADO (release `d542cda`, 2026-07-31; arfagi migrado a `external_managed` con smoke humano aprobado)
- **Fecha:** 2026-07-30
- **Programa:** META-CATALOG-OWNERSHIP-MODEL-1
- **Relacionados:** ADR-0012 (contrato de escritura), ADR-0013 (outbox + preview binding), ADR-0014 (importación genérica y calidad)

## Contexto

La auditoría META-CATALOG-SOURCE-OF-TRUTH-AUDIT-1 (2026-07-30) probó que el catálogo de Meta de
arfagi lo gobierna **un feed diario del propio sitio del tenant** (fuente primaria, con borrado
habilitado, que publica los 181 artículos cada madrugada). Nuestra única escritura real —el canary
de Odyssey— vivió unas 36 horas antes de ser revertida. Los hallazgos estructurales:

1. `sourceOfTruth` es un literal decorativo: su único valor legal es `'vendeyapy'` y cualquier otro
   apaga la sincronización entera. No representa autoridad, no verifica exclusividad de escritura y
   el código no conoce el concepto de fuente externa.
2. `metaSyncStatus: 'synced'` es una afirmación sobre el pasado que nada caduca: un job `succeeded`
   es terminal y ninguna consulta del ciclo lo vuelve a mirar.
3. La detección de deriva remota solo cubre productos importados, excluyendo justamente a los
   vinculados manualmente, que son los únicos con opt-in.
4. El bot cotiza el precio local y el checkout no revalida contra Meta: hoy existe una divergencia
   activa del 92 % sobre el único producto sincronizado.
5. Con `mode:'live'` habría un loop diario estructural: el feed revierte, el planificador detecta
   diferencia, el apply vuelve a escribir, indefinidamente y sin alarma.

## Decisión

### 1. Propiedad explícita por campo, en la config que ya existe

`tenants/{t}/config/meta.catalogSync` suma `ownership` y **retira el uso efectivo de
`sourceOfTruth`** (se conserva la lectura del documento legacy solo para migración; jamás se
interpreta como permiso de escritura):

```ts
ownership: {
  model: 'vendeyapy_managed' | 'external_managed' | 'hybrid';
  ownedFields: WritableField[];              // campos que VendeYaPy escribe (canónico: ordenado, único, ⊆ WRITABLE_FIELDS)
  external: {                                 // fuente externa reconocida por un humano
    kind: 'meta_feed' | 'commerce_manager' | 'other_api';
    acknowledgedSourceIds: string[];          // ids de feed/data source RECONOCIDOS
    declaredFields: WritableField[];          // campos que esa fuente publica
    fingerprint: string;                      // huella SANEADA (nunca URL firmada, nunca token)
    acknowledgedAt: Timestamp;
    acknowledgedByUid: string;
  } | null;
  lastSourceCheckAt: Timestamp | null;
}
```

Campos públicos del contrato (`WritableField`): `title`, `description`, `price`, `currency`,
`availability`, `inventory`, `brand`, `category`, `image`, `url`. **Un campo tiene exactamente un
propietario**: `ownedFields ∩ external.declaredFields = ∅` es invariante de validación, no una
convención.

**Nunca publicables ni delegables**: costo, márgenes, `productFinancials`, `aiFicha`, `aiNotes` y
cualquier dato interno. No son `WritableField` y no pueden aparecer en ninguna de las dos listas.

### 2. Fail-closed de dos niveles

- **Nivel 1 (existente, intacto):** `catalogSync` ausente o malformado, `enabled !== true`, `mode`
  fuera de `{dry_run, live}` o `catalogId` inválido ⇒ sincronización apagada por completo, ni una
  llamada a Meta. Un tenant sin config (credipower) sigue exactamente igual.
- **Nivel 2 (nuevo):** config válida pero `ownership` ausente, legacy, inválida o contradictoria
  ⇒ **cero campos escribibles**, apply bloqueado, **modo efectivo `dry_run`** y alerta
  administrativa. Se puede diagnosticar y leer; no se puede escribir. Un documento legacy (solo
  `sourceOfTruth`) cae acá: se migra explícitamente, jamás se asume permiso.

### 3. Semántica de los tres modelos

- `vendeyapy_managed`: VendeYaPy gobierna los campos públicos declarados y publica a Meta. Exige
  ausencia de fuentes externas incompatibles: si la detección encuentra una no reconocida, las
  escrituras quedan bloqueadas hasta el reconocimiento humano.
- `external_managed`: el sitio/ERP/feed gobierna los campos públicos. `ownedFields` vacío ⇒
  **cero jobs outbound**, aunque alguien ponga `mode:'live'` por error. VendeYaPy ingiere,
  reconcilia y **avisa**; no copia ciegamente el remoto sobre los campos comerciales locales.
- `hybrid`: matriz explícita campo por campo. La propiedad **no se infiere**; declarar un campo en
  ambos lados es config inválida (nivel 2).

### 4. Detección de fuentes externas

Lectura por la API oficial ya autorizada (solo GET). Se persiste **metadata saneada**: tipo,
identificador no secreto, nombre saneado, schedule, campos detectados, última verificación, estado
y quién/cuándo reconoció. **Jamás** se persiste ni se loguea la URL firmada, su query string, el
token, credenciales ni el archivo crudo. El `fingerprint` se calcula sobre datos no secretos
(identificador, host sin query, horario, columnas declaradas).

La detección corre en el onboarding, antes de autorizar `live`, periódicamente y **inmediatamente
antes de un POST outbound sensible**. Fuente desconocida o fingerprint cambiado ⇒ **bloqueo de
escrituras + alerta agregada idempotente**. Nunca se desactiva el feed ni se cambia el modelo de
forma automática: eso es decisión humana.

### 5. Estado histórico contra estado actual

Se separan dos ejes que hoy están confundidos:

- **Histórico (inmutable):** el job del outbox conserva `succeeded`/`failed` y su log. Es evidencia
  de lo que pasó, y no cambia.
- **Actual (proyección que caduca):** el producto pasa a tener `metaSyncState` con
  `verified`, `drifted`, `drifted_external`, `remote_missing`, `unverifiable`, `stale`, más los
  estados operativos ya existentes. Se agregan `metaVerifiedAt` (cuándo LEÍMOS Meta y comparamos —
  distinto de `metaLastSyncAt`, que sigue siendo la última ESCRITURA confirmada) y `metaDrift`
  (campos divergentes, dueño, severidad, fuente relacionada y valores observados estrictamente
  necesarios y saneados).

`verified` **solo** se escribe tras una lectura remota real, y además **solo si se pudo comparar al
menos un campo comercial** (precio, moneda, disponibilidad o stock). Haber comparado únicamente
texto —título, descripción— no autoriza a afirmar que el producto "coincide con lo publicado":
sería el mismo verde sin evidencia que este ADR existe para eliminar. Si ningún campo comercial
resultó comparable, el estado honesto es `unverifiable` y la observación registra cuáles no se
pudieron comparar. La caducidad es derivada en lectura (`verifiedAt` más antiguo que el TTL ⇒
`stale`), para que ningún job que falle deje el estado mintiendo. TTL documentado: el menor entre
24 horas y el período de la fuente externa reconocida.

### 6. Reconciliación periódica

Cubre **importados y vinculados manualmente** (cierra el hueco que dejó ciego a Odyssey), pagina el
catálogo completo, es idempotente, reanudable y aislada por tenant, **no escribe en Meta**, detecta
cambios posteriores a un job exitoso y artículos eliminados por el feed, **nunca borra producto ni
lock automáticamente** y no duplica alertas.

**Corre sola, y no es opcional.** Declarar la propiedad deja los productos mapeados sin
`metaVerifiedAt`, y sin `metaVerifiedAt` el estado efectivo es `stale`, que bloquea la venta
automática (§8). La regla del owner —"lo vencido no cierra venta"— **solo es sostenible si algo
refresca la evidencia**: sin reconciliación automática, esa caducidad no se levanta nunca y la venta
queda apagada de forma permanente. Por eso el scheduler corre **dos veces por día (04:30 y 16:30
America/Asuncion) contra un TTL de 24 h**: con una sola corrida diaria, cualquier demora o corrida
fallida vencería el catálogo entero antes del siguiente intento; con dos, una corrida perdida no
apaga la venta. La de las 04:30 corre **después** de la ventana del feed diario, así que la foto es
la del catálogo ya republicado. Las reglas duras son las mismas del outbox: solo tenants `ACTIVE`,
fail-closed por config (un tenant sin `catalogSync` no gasta ni una llamada), presupuesto acotado
por corrida con reanudación por cursor, y un tenant que falla jamás frena a los demás.

**Ningún producto puede quedar trabado.** Un mapeado que la reconciliación no logre resolver contra
el catálogo remoto debe terminar en un estado que describa lo observado (`remote_missing`), no en un
`unverifiable` perpetuo del que nada lo saque: un estado sin salida apaga la venta de ese producto
para siempre.

**Si el guard está prendido, el refresco también tiene que poder correr.** La reconciliación es una
operación de LECTURA y no puede quedar gateada por nuestro interruptor de escritura: con el sync
apagado, el guard sigue activo (§8) pero nada volvería a sellar `metaVerifiedAt`, y a las 24 horas
el catálogo entero pasaría a `stale` — venta automática apagada en silencio y para siempre. Es el
mismo modo de falla que este ADR combate, con el signo invertido. Los dos ejes se separan igual que
en todo el resto: **permiso de escritura** depende de `enabled`/`mode`; **capacidad de verificar**
depende de que haya gobierno externo declarado y un catálogo remoto que leer. Una configuración que
declara gobierno externo pero hace la verificación estructuralmente imposible es contradictoria y
debe resolverse de forma visible —degradando la propiedad o alertando—, nunca con un apagado mudo.

La regla vale **en las dos direcciones**: si el guard **no** está prendido, no hay evidencia que
refrescar. "Gobierno externo declarado" significa acá lo mismo que para el guard (§8): que la fuente
externa gobierne algún campo **comercial**. Una declaración puramente cosmética —el feed publica el
título y la imagen— deja el guard inerte, así que no justifica paginar el catálogo remoto dos veces
por día ni el gasto contra Meta que eso implica. Y todo cierre del bloqueo —configurar el catálogo,
retirar la declaración externa o **desconectarse borrando la config entera**— cierra también su
aviso: un aviso que ninguna acción del owner puede cerrar es ruido eterno.

### 7. Gates outbound

Todo preview, apply, encolado y claim usa un **snapshot de ownership**. Antes de encolar y otra vez
inmediatamente antes del POST se revalida: tenant, config, modo, propiedad de cada campo del patch,
fuentes externas y fingerprint, opt-in, mapping y huella del plan. **Un patch solo puede contener
campos propios.** Si la propiedad cambia mientras un job está en vuelo: no se envía, el job queda en
estado terminal o de atención coherente, se alerta, y jamás se reintenta con permisos viejos. Con
`external_managed` y `ownedFields` vacío no existe patch posible: el loop diario es inalcanzable
por construcción.

### 8. Bot y checkout

Guard determinístico **antes de la IA y antes de crear la orden**. Para productos gobernados
externamente cuyo precio, disponibilidad o stock estén `drifted_external`, `remote_missing`,
`unverifiable` o vencidos: no se afirma precio ni stock como confirmados, **no se crea orden**, no
se envían datos bancarios, y se deriva a un humano por el servicio canónico de handoff con razón
estructurada, notificación única e idempotente, conservando carrito y conversación. Divergencias
cosméticas (nombre, mayúsculas, descripción) no cortan la conversación: generan advertencia
administrativa. La fuente de precio sigue siendo local — el pedido lo cobra VendeYaPy y el camino
crítico no puede depender de una llamada externa —; lo que cambia es la honestidad.

**El guard cubre todo camino que le afirme un precio a una persona o que mande datos de pago**, no
solo el que nombra un producto: el listado y lo que la IA ve, la vista de carrito (también con el
pago ya pedido), los interceptores determinísticos, el checkout y **las ramas de reuso y
reanudación** — un pedido creado antes de que apareciera la deriva no puede reenviar instrucciones
bancarias sin volver a preguntar. En el listado la respuesta correcta es **excluir** el producto
(igual que uno inactivo o sin stock: nadie corta una conversación por un artículo entre 181); cuando
el cliente lo **nombra**, se deriva a una persona — negarle que existe sería mentir.

**"No hay deriva" y "no pude leer si la hay" no son lo mismo donde hay plata comprometida.** En los
caminos que crean o recobran una orden, un fallo de lectura de la proyección vale `unverifiable`: no
se crea la orden, no salen datos bancarios y se deriva. Ese fail-closed alcanza **solo a lo que
alguien puede estar publicando afuera**: un producto sin identidad remota no tiene una segunda cara
que pueda contradecir su precio local, así que un parpadeo de Firestore no puede frenar el carrito
de un tenant que no publicó un solo artículo. La señal que decide eso **no puede ser la config del
tenant** —esa pregunta es fail-safe y el mismo parpadeo la haría responder "no aplica", creando la
orden al precio equivocado justo en el tenant gobernado por un feed—: se contesta con los productos,
y si tampoco se puede saber quién está publicado, se bloquea todo lo consultado.

**El guard no depende de nuestro interruptor de sincronización.** Que VendeYaPy deje de escribir
(`enabled:false` o `mode:'off'`) no cambia quién gobierna el catálogo allá afuera: si hay una fuente
externa reconocida, el guard sigue activo. Acoplar una cosa a la otra haría que apagar el sync
apague la honestidad. Lo que sí deja el guard inerte —y debe— es que **nadie haya declarado gobierno
externo**: sin `ownership.external` reconocida no hay nada que contradiga el precio local.

### 9. Migración

Operación administrativa preview/apply, persistida e idempotente, que propone el modelo, los campos,
los feeds detectados, los productos afectados y los estados que cambiarían. El apply exige
confirmación explícita y precondiciones frescas. Para arfagi el resultado esperado es
`external_managed`, todos los campos públicos del feed como externos, `mode:'dry_run'`, feed
reconocido **sin guardar su URL ni su token**, Odyssey en `drifted_external` (local ₲250.000 contra
remoto ₲130.000) y credipower intocado.

## Consecuencias

- El precio correcto de Odyssey (₲250.000, decisión del owner) **se corrige en el origen que genera
  el feed**, no escribiendo en Meta. Mientras el feed publique ₲130.000, el producto queda
  `drifted_external` y no cierra una venta automáticamente.
- El loop diario deja de ser posible para tenants gobernados externamente.
- El panel deja de mostrar verde sobre productos divergentes; el centro de calidad incluye la deriva
  también para vinculados manualmente.
- Un tenant nuevo con feed propio ya no reproduce el conflicto: el onboarding lo detecta y el
  fail-closed de nivel 2 impide escribir hasta que un humano declare la propiedad.
- Queda pendiente (fuera de este ADR): extender el contrato de escritura a `sale_price` para
  promociones, y el rediseño incremental del diff completo del catálogo (tope de 5.000 del plan).
