# ADR-0012 — Contrato de escritura del Meta Catalog: lectura y escritura son formatos distintos

**Fecha:** 2026-07-27
**Estado:** Aceptada e implementada (programas META-CATALOG-OUTBOUND-CONTRACT-1 y -HARDEN-1)
**Decisores:** Owner del proyecto

---

## Contexto

La sincronización de catálogo hacia Meta (ADR-0009, Track D) se construyó con un **único
serializador** que armaba el "item público" y lo usaba para dos cosas a la vez: comparar
contra lo que Meta devuelve al leer, y enviar los cambios al escribir.

Eso era un error de base. La Graph API de Meta usa **dos contratos distintos** para el mismo
objeto:

| | Al LEER (`GET /{catalog}/products`) | Al ESCRIBIR (`POST /{catalog}/items_batch`) |
|---|---|---|
| Nombre | `name` | **`title`** |
| Imagen | `image_url` (string) | **`image`** (array de `{url, tag?}`) |
| URL | `url` | **`link`** |
| Identidad | `retailer_id` (campo del objeto) | **`data.id`** |

El serializador emitía los nombres de la **lectura** dentro de un request de **escritura**, y
además colocaba la identidad como hermano de `data` en vez de dentro. Como el camino `live`
nunca se ejecutó contra Meta real (solo contra un cliente fake que aceptaba cualquier forma),
el defecto sobrevivió a toda la batería de tests y a dos revisiones adversariales.

Auditoría documental que lo detectó: META-CATALOG-GENERIC-IMPORT-AUDIT-DESIGN-1.

## Decisión

### 1. Los cuatro contratos viven separados y explícitos

- **Contrato de LECTURA** — `MetaRemoteCatalogItem` (`meta/catalogClient.ts`) y
  `localPublicView()` (`meta/catalog.ts`). Se usan EXCLUSIVAMENTE para el diff: comparar el
  estado local contra lo que devuelve un GET. Jamás se envían.
- **Contrato de ESCRITURA** — `meta/catalogOutbound.ts`, módulo dedicado, con tres builders:
  - `buildCatalogCreatePayload(p)` → `{ method: 'CREATE', data: {...9 obligatorios} }`
  - `buildCatalogUpdatePatch(p, changedFields)` → `{ method: 'UPDATE', data: { id, ...solo lo modificado } }`
  - `buildCatalogDisablePatch(p)` → `{ method: 'UPDATE', data: { id, availability: 'out of stock' } }`

El tipo `CatalogBatchRequest` es `{ method, data: { id: string } & Record<string, unknown> }`:
**la identidad fuera de `data` no compila**.

### 2. CREATE es fail-closed

Meta exige para crear: `id, title, description, link, price, availability, condition, brand,
image`. Si falta alguno, `createBlockers()` lo reporta y el builder **lanza**. Nunca se
inventa un link, una marca, una categoría ni una imagen. El planner traduce esos bloqueos a
motivos visibles (`product_url_missing`, `brand_missing`, `description_missing`).

### 3. UPDATE es un patch parcial de verdad

Solo viajan la identidad y los campos realmente modificados. Un cambio de precio manda
exclusivamente `{ id, price }`. **Un UPDATE no exige `link`, marca ni imagen**: actualizar un
artículo que ya existe en Meta no puede depender de campos que no se están enviando. Los
campos ajenos al contrato público se descartan en silencio (whitelist cerrada).

### 4. DISABLE es la palanca mínima

Solo `{ id, availability: 'out of stock' }`. No toca nombre, precio, imagen, descripción ni
URL, y funciona aunque al producto le falten obligatorios de creación. **Nunca DELETE**: el
borrado físico será una operación aparte con confirmación humana explícita.

### 5. `allow_upsert: false` explícito

El default de Meta es `true`: un UPDATE **crea** el artículo si no existe. Con ese default,
un "create" mal clasificado se ejecutaría en silencio como upsert. Lo enviamos en **false**
para que crear sea siempre una decisión declarada del planner (`method: 'CREATE'`) y un
UPDATE contra un artículo inexistente falle de forma visible en vez de crear algo a medias.

### 6. El fake valida el contrato

`FakeMetaCatalogClient` dejó de aceptar payloads arbitrarios. `assertBatchRequestShape()`
rechaza: identidad fuera de `data`, campos del contrato de lectura (`name`, `image_url`,
`url`, `retailer_id`), **cualquier campo ajeno al contrato** (es whitelist, no blacklist: un
`costPrice` o un `aiNotes` colado se rechazan), `DELETE`, CREATE sin obligatorios, UPDATE sin
identidad, `id` de más de 100 caracteres, e `image`/`price`/`link`/`title` con forma inválida.
El E2E de emulador falla igual que fallaría Meta.

### 7. Campos nuevos en el modelo

- `Product.productUrl` — el `link` del contrato. **Opcional**: los productos existentes no lo
  tienen. Es obligatorio solo para CREAR (bloqueo `product_url_missing`). Se agregó a la
  whitelist de `validateProductPatch` para que sea editable desde el panel: sin ese camino,
  ningún producto podría crearse nunca en Meta.


### 8. Una sola derivación de cada campo público

`localPublicView` (lectura) y los builders (escritura) **comparten las funciones que derivan
los valores** (`outboundTitle`, `outboundDescription`, `outboundPrice`, `outboundId`, …).
Tener dos implementaciones paralelas produjo tres defectos a la vez: distinto truncado del
título (200 vs 100) generaba updates perpetuos; distinto tratamiento de la identidad hacía que
los errores por item no matchearan; y un fallback de descripción presente en un lado y ausente
en el otro hacía que un producto con descripción vacía lanzara y **cancelara el plan de todo
el tenant**. Una sola fuente elimina la clase entera de bugs. (El fallback de descripción se
eliminó por completo después — ver §13: no se inventa contenido publicable.)

### 9. La identidad es EXACTA: truncar está prohibido

`outboundId` devuelve el `metaRetailerId` (o el SKU) **tal cual está guardado**. Recortarlo al
máximo del contrato tenía dos consecuencias graves: dos identidades largas con el mismo
prefijo colapsaban en una sola —dos productos escribiendo sobre el mismo artículo de Meta— y
el id emitido dejaba de coincidir con el almacenado, de modo que la verificación post-escritura
y los errores por item nunca volvían a matchear. Si la identidad excede los 100 caracteres del
contrato, el producto se **bloquea** con `identity_too_long`, en las tres operaciones y antes
de cualquier transporte. **El `metaRetailerId` persistido y el mapping jamás se modifican para
adaptarse a Meta.**

### 10. VendeyaPy no representa DELETE

`CatalogBatchMethod` es `'CREATE' | 'UPDATE'`. Meta conoce `DELETE`, pero este sistema no lo
implementa: dar de baja es `availability: 'out of stock'`, y el borrado físico será una
operación aparte con confirmación humana. Al no existir en el tipo no es construible, y
`assertBatchRequestShape` lo rechaza aunque se lo cuele por un cast.

### 11. El validador corre también en producción

`assertItemsBatchBody` valida el **body completo** —`item_type`, `allow_upsert === false`,
lote no vacío y dentro del límite, y cada request— y se ejecuta en `HttpMetaCatalogClient`
**antes del POST real**, no solo en el fake. Es la última barrera antes de la red.

### 12. La URL: HTTPS obligatoria, canónica y comparada

Crear exige una URL **https absoluta** (`product_url_not_https`); `validateProductPatch`
rechaza `http:`, `javascript:`, `data:` y rutas relativas al guardar. Además `productUrl`
entró al **diff** (`url` en la vista de lectura, `link` al escribir): un cambio exclusivo de
URL produce `{ id, link }`, y un artículo cuyo link remoto no coincide **no puede declararse
`synced`**.

**Una sola normalización: `canonicalHttpsUrl`.** Devuelve `URL.href` (esquema en minúsculas,
host en punycode, path escapado) o `null`, y la usan por igual el serializador, el validador
de transporte y el diff. Validar con dos criterios distintos —`new URL()` de un lado,
`startsWith('https://')` del otro— hacía que un valor aceptado al construir explotara recién
en el POST, envenenando el lote entero. Y comparar la forma cruda contra la que Meta devuelve
normalizada producía un UPDATE en cada corrida que nunca convergía. Si Meta no expone `url`,
no se asume que cambió.

`productUrl` es editable desde el panel (ProductForm) y los productos importados nacen con el
`url` que Meta ya publica: no se inventa, y si no viene queda vacío.

### 13. La descripción no se inventa

`outboundDescription` ya no cae al título. Vacía ⇒ `description_missing` y el producto queda
bloqueado. Un UPDATE que solo toca el precio **no** se bloquea por una descripción local
ausente; pedir explícitamente sincronizar `description` vacía sí, con motivo estructurado
(`updateBlockers`).

### 14. Un producto roto no cancela el plan ni envenena el lote

La serialización de cada producto va dentro de un try/catch: si sus datos no entran en el
contrato, queda `blocked` con motivo `serialization_failed` y la corrida continúa con los
demás. En el apply, cada entrada se valida **individualmente** antes de armar el chunk: la
que no pase queda `failed` sola y las demás se envían igual. Sin ese aislamiento un único
request inválido tumbaba su chunk completo y todos los siguientes, de forma determinística.

### 15. El gate de habilitación y el planificador dicen lo mismo

`syncEnableBlockers` reusa `createBlockers` cuando el artículo **todavía no existe en Meta**:
habilitar prometiendo "se va a crear" un producto que el planificador va a bloquear para
siempre —por falta de enlace, descripción o marca— es mentirle al dueño. Si el artículo ya
existe, esos obligatorios no se exigen: un UPDATE parcial no los manda. `identity_too_long`
bloquea en ambos caminos. La marca no se pide por rubro sino porque Meta la exige para crear.

### 16. La identidad del lock es inyectiva

`retailerIdLockKey` sanea el retailer_id para usarlo como id de documento, y sanear pierde
información: `ARM/1` y `ARM#1` colapsaban en la misma clave, de modo que el lock del primero
declaraba al segundo "ya vinculado a otro producto" para siempre. Ahora los ids que ya son
seguros pasan **tal cual** (idénticos a los históricos: verificado contra producción, 30
importados y 1 lock, cero divergencias) y solo los que requieren saneo llevan un sufijo hash.

### 17. Qué significa `synced`

"Ningún campo **gestionado** difiere" — no "Meta es un espejo de VendeyaPy". Lo que este
sistema no administra (categorías de Meta, product_type, variantes, campos cargados a mano en
Commerce Manager) puede diferir y el producto igual figura `synced`. La sincronización es de
un subconjunto declarado, no una réplica.

## Caveat operativo de `allow_upsert: false`

`items_batch` es asíncrono. Si un segundo apply corre antes de que Meta termine de procesar
el primero, `listItems` todavía no devuelve el artículo recién creado, el plan vuelve a
clasificarlo como `create` y Meta rechaza el segundo CREATE por id duplicado. El producto
queda `failed` y el run como `partial_failure` — **ruido, no daño**: la corrida siguiente lo
ve ya presente y converge. Con el upsert implícito esto no pasaba, pero a cambio un create
mal clasificado se ejecutaba en silencio. Se prefiere el fallo visible.

## Consecuencias

- **Cero escrituras reales en Meta hasta la prueba controlada.** El camino `live` sigue sin
  ejecutarse en producción: `catalogSync` permanece en `dry_run`, ningún producto tiene
  `syncToMeta: true`, y no hubo un solo `items_batch`.
- Los productos existentes **no pueden crearse** en Meta hasta que se les cargue `productUrl`
  y marca — por diseño: antes se habrían enviado incompletos y Meta los habría rechazado. El
  panel ya permite cargar el enlace y el gate explica exactamente qué falta.
- Un UPDATE de un artículo ya vinculado (caso Armaf Odyssey: solo precio) **no queda
  bloqueado** por no tener `productUrl` local.
- La verificación con fake ya no da falsa confianza sobre el contrato.

## Pendiente

La **primera escritura real** (Odyssey: precio ₲130.000 → ₲250.000 en Meta) queda como
programa separado y controlado, con preview del diff exacto, un solo campo, verificación por
GET y kill-switch inmediato.

## Relación con otros ADR

- **ADR-0009** — arquitectura de integración con Meta: este ADR precisa el formato outbound
  que aquel dejó abierto.
- **ADR-0010** — requisitos de Meta para ir en vivo: el gate de App Review/Advanced Access
  sigue siendo el bloqueo para administrar catálogos de terceros.
