# Runbook — Backup y restauración

> **Estado**: herramientas construidas y probadas contra el emulador. **Nunca se ejecutaron contra
> producción.** Este runbook describe el procedimiento; ejecutarlo sobre `vpw-prod-dd6ff` requiere
> aprobación explícita del owner y es un programa aparte.
>
> Última actualización: **2026-08-04** (programa `WHATSAPP-COEXISTENCE-FOUNDATION-COMPLETE-1`, etapa F).

---

## 0. Lo primero, porque es lo que más se malentiende

**Restaurar Firebase NO deshace cambios externos.** Un restore repone documentos, usuarios y
configuración de Firebase. No revierte:

- nada que **Meta** ya haya hecho (onboarding, `account_update`, estado del WABA, catálogo);
- nada que la **app WhatsApp Business del vendedor** haya hecho en su teléfono (mensajes enviados,
  etiquetas, difusiones);
- pagos, cobros ni comunicaciones que ya salieron.

**Un restore NO des-onboardea un número.** Si el número real entró en Coexistence, sigue onboardeado
después del restore. Desconectarlo es un acto del cliente desde su app: la Deregister API está
**prohibida** para números en coexistencia (ADR-0017 §6).

Consecuencia operativa: tras un restore, el estado externo puede quedar **adelantado** respecto de
los datos. `automationMode`, los assets y el índice de ruteo vuelven al momento del backup aunque
Meta ya haya emitido un `account_update`. **Reconciliar contra Meta antes de volver a `live`.**

Dos hechos más, auditados, que hay que tener presentes:

| Hecho | Consecuencia |
|---|---|
| Un **backup gestionado de Firestore retiene hasta 14 semanas** | Choca con el **TTL de 48 h** del archivo de Coexistence (`metaWebhookHistory`, `metaWebhookAppState`, `metaWebhookShadow`). Lo que el TTL borra a las 48 h **sigue existiendo dentro del backup gestionado por semanas**. Tenerlo en cuenta al responder un pedido de borrado de datos. |
| **Un restore NO repone las políticas TTL** | El TTL es configuración de la **base**, no un dato. Sobre una base nueva hay que **volver a crearlas** o esas colecciones dejan de purgarse y crecen sin límite. `backup-infra.mjs` las enumera para poder recrearlas. |

Estas advertencias viajan **dentro de cada manifiesto**, no solo acá: el runbook se lee antes del
incidente, el manifiesto se lee durante.

---

## 1. Qué herramienta es cuál

| Herramienta | Qué es | ¿Restaurable? |
|---|---|---|
| `apps/functions/scripts/backup-firestore.mjs` | Backup de Firestore de un tenant: subárbol completo por descubrimiento recursivo + colecciones globales del tenant + ciphertext de los secretos referenciados | **Sí** |
| `apps/functions/scripts/backup-auth.mjs` | Usuarios, pertenencia y **custom claims** | **Sí** (sin contraseñas — ver §5) |
| `apps/functions/scripts/backup-storage.mjs` | **COPIA COMPLETA de bytes** + inventario, verificación md5/tamaño por objeto (correctivo 2026-08-04) | Sí: `restore-storage.mjs` restaura a emulador o destino aislado (producción PROHIBIDA sin excepción), con verificación posterior completa |
| `apps/functions/scripts/backup-infra.mjs` | Manifiesto de infraestructura: commit, Rules, índices, **TTL**, Functions, schedulers, nombres de secretos y config | No: es documentación ejecutable de lo que hay que recrear |
| `apps/functions/scripts/restore-firestore.mjs` | Restauración de Firestore | — |
| `apps/functions/scripts/restore-auth.mjs` | Restauración de identidad y claims | — |
| `apps/functions/scripts/backup-restore-e2e.mjs` | Prueba automatizada del ciclo completo contra el **emulador** | — |
| `apps/functions/scripts/export-tenant.mjs` | **EXPORT DE PORTABILIDAD — PARCIAL Y NO RESTAURABLE** | **No.** Ver §6 |

Reglas comunes a todas: **proyecto y tenant obligatorios**, **dry-run por defecto** (`--apply`
enciende los efectos), **salida absoluta y fuera del repo**, manifiesto con conteos y hashes, logs
por huella (sin PII ni secretos), y **exit ≠ 0** ante cualquier fallo o resultado vacío.

---

## 2. Backup completo de un tenant

```bash
# 0) Elegir un destino ABSOLUTO y FUERA del repo, en un disco que no se sincronice a la nube.
DEST=/d/backups/vpw/$(date +%Y%m%d-%H%M)

# 1) Dry-run: recorre, cuenta y NO escribe nada. Sirve para ver el alcance real.
node apps/functions/scripts/backup-firestore.mjs --project <projectId> --tenant <tenantId> --out "$DEST"

# 2) Aplicar, pieza por pieza
node apps/functions/scripts/backup-firestore.mjs --project <projectId> --tenant <tenantId> --out "$DEST" --apply
node apps/functions/scripts/backup-auth.mjs      --project <projectId> --tenant <tenantId> --out "$DEST" --apply
node apps/functions/scripts/backup-storage.mjs   --project <projectId> --tenant <tenantId> --out "$DEST" --apply
# restaurar (emulador o destino aislado; producción prohibida):
# node apps/functions/scripts/restore-storage.mjs --project <demo-*> --desde "$DEST" --out <reporte> [--bucket <b>]  # dry-run imprime la huella
# node apps/functions/scripts/restore-storage.mjs ... --confirmo <huella> --apply
node apps/functions/scripts/backup-infra.mjs     --project <projectId> --out "$DEST" --apply
```

Contra un proyecto real hay que exportar `GOOGLE_APPLICATION_CREDENTIALS`; contra el emulador,
`FIRESTORE_EMULATOR_HOST`. **Nunca los dos**.

### Qué queda en `$DEST`

```
firestore.ndjson            manifest-firestore.json
auth.ndjson                 manifest-auth.json
storage.ndjson              manifest-storage.json
                            manifest-infra.json
```

**Ese directorio contiene datos personales de clientes reales.** Tratarlo como tal: disco cifrado,
permisos restringidos, retención acordada, y jamás dentro del repo (las herramientas lo impiden, y
`.gitignore` es la segunda red).

### Verificaciones que valen la pena mirar

- `manifest-firestore.json → documentos.existentes` y `conteosPorColeccion`: ¿aparecen `messages`,
  `sessions` y los ítems de pedido? Si no, el tenant no tiene ese dato (o algo está mal).
- `secretos.faltantes` **debe ser 0**. Si no, hay referencias colgadas y un restore dejaría esas
  conexiones sin credencial.
- `manifest-auth.json → usuarios.delTenant` y `rolesPorConteo`: sin claims, el tenant restaurado es
  inaccesible.
- `manifest-storage.json → muestreo.fallidos` **debe ser 0**.

---

## 3. Restauración

### 3.1 Dónde se puede restaurar

| Destino | ¿Permitido? |
|---|---|
| Emulador (`FIRESTORE_EMULATOR_HOST` seteado) | **Sí** |
| Proyecto aislado (`demo-*`, `*-restore-*`, `*-sandbox-*`) **con base Firestore de nombre propio** | **Sí**, con `--proyecto-aislado --database <id>` |
| Cualquier proyecto de producción | **NO. Bloqueado, sin flag que lo habilite.** |

El bloqueo de producción es una **negativa**, no una confirmación difícil: se identifica por el alias
`production` de `.firebaserc` **y** por heurística de nombre (cualquier projectId que contenga
`prod`). La heurística solo puede rechazar de más, que es la única dirección aceptable.

### 3.2 Procedimiento

```bash
# 1) Dry-run: clasifica cada documento (ausente / idéntico / divergente), reporta conflictos
#    y sobrantes, y IMPRIME la huella del destino. No escribe nada en la base.
node apps/functions/scripts/restore-firestore.mjs \
  --project <destino> --desde "$DEST" --out /d/backups/vpw/reportes

# → [restore-firestore] … huella del destino: a1b2c3d4e5f6

# 2) Aplicar, copiando ESA huella. Confirmar así es la prueba de que se miró el destino.
node apps/functions/scripts/restore-firestore.mjs \
  --project <destino> --desde "$DEST" --out /d/backups/vpw/reportes \
  --confirmo a1b2c3d4e5f6 --apply

# 3) Identidad (sin esto el tenant restaurado no deja entrar a nadie)
node apps/functions/scripts/restore-auth.mjs \
  --project <destino> --desde "$DEST" --out /d/backups/vpw/reportes \
  --confirmo <huella> --apply
```

Comportamiento que conviene conocer antes de necesitarlo:

- **Nada se borra, nunca.** Los documentos y usuarios del destino que no están en el backup se
  informan como *sobrantes* y quedan intactos.
- **Ante documentos divergentes el restore ABORTA** y deja el detalle en el reporte.
  `--sobrescribir` es una decisión explícita.
- **Verificación posterior obligatoria**: después de escribir, el restore relee todo y compara
  hashes. Si algo no coincide, sale con error.
- **Es idempotente**: repetirlo sobre un destino ya restaurado no reescribe nada.

### 3.3 Después de un restore

1. **Recrear las políticas TTL** (no vuelven solas). Las declaradas están en
   `manifest-infra.json → ttl.declaradas`; la de `metaWebhookInbox` es política de consola y **no**
   está versionada — verificar con `gcloud firestore fields ttls list`.
2. **Reponer la clave de cifrado** del entorno (`TENANT_SECRETS_ENCRYPTION_KEY`). El backup guarda el
   ciphertext, **no** la clave: sin ella, el ciphertext restaurado no sirve para nada.
3. **Contraseñas**: los usuarios conservan uid, perfil y claims, y deben **restablecer contraseña**
   (ver §5).
4. **Objetos de Storage**: restaurarlos con la herramienta del proveedor y verificar contra
   `storage.ndjson`. Sin los bytes, adjuntos y comprobantes quedan rotos.
5. **Reconciliar con Meta antes de volver a `live`** (ver §0).
6. Revisar `manifest-infra.json → pendientesFueraDeAlcance`: IAM, schedulers y Rules desplegadas.

---

## 4. La prueba que hace real al backup

```bash
# Emuladores en otra terminal:
pnpm exec firebase emulators:start --only firestore,auth,storage --project demo-aiafg

pnpm --filter functions build   # la prueba de descifrado usa el módulo REAL de crypto

FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
STORAGE_EMULATOR_HOST=http://127.0.0.1:9199 \
node apps/functions/scripts/backup-restore-e2e.mjs
```

El ciclo es **semilla sintética → backup → mutación del origen → restore en un destino aislado →
equivalencia**. La mutación es lo que hace que la comparación signifique algo: sin ella, origen y
destino podrían coincidir simplemente porque nadie tocó nada.

Comprueba subcolecciones profundas (mensajes, sesiones, ítems), sesiones **por canal** (ADR-0017 §2),
el índice global de ruteo, las conexiones Meta, los tipos (`Timestamp`/`GeoPoint`/`Bytes`), los
padres fantasma, usuarios y **claims**, el inventario de Storage con checksum, y que **el ciphertext
restaurado descifra al mismo plaintext** (comparado por hash: el valor no se imprime nunca).

> **Verificación con Meta — paso del Programa 2, no de este.** La comprobación definitiva de que un
> token restaurado sigue sirviendo es una llamada **read-only** a Graph (por ejemplo
> `GET /<WABA_ID>/phone_numbers`) desde un entorno de prueba. Este programa tiene **prohibido**
> llamar a `graph.facebook.com`, así que la prueba equivalente sin red es la del descifrado. Queda
> pendiente y explícita: **ejecutar esa verificación Graph read-only antes de dar por bueno un
> restore que vaya a operar.**

---

## 5. Limitaciones conocidas, dichas antes de que duelan

| Limitación | Por qué | Qué hacer |
|---|---|---|
| **Sin hashes de contraseña** | Reimportarlos exige además el `hash_config` del proyecto, que es configuración y no dato del usuario; guardar el hash sin él produce material de credenciales que además no restaura | Complementar con `firebase auth:export` (ese archivo **sí** contiene credenciales) o hacer que los usuarios restablezcan contraseña |
| **Storage: bytes con custodia** | Los bytes copiados son fotos y PDF de clientes: el destino es OBLIGATORIAMENTE fuera del repo, con permisos 0600 y logs por huella | El backup viejo (solo inventario, sin `copiaDeBytes`) lo rechaza `restore-storage.mjs` con explicación |
| **TTL no se repone** | Es configuración de la base | §3.3 paso 1 |
| **Clave de cifrado fuera del backup** | A propósito: un backup que trae la clave y el ciphertext juntos no protege nada | §3.3 paso 2 |
| **`backup-infra.mjs` no lee IAM ni Scheduler** | Requieren `gcloud`, no `firebase` | Los comandos exactos están en `manifest-infra.json → pendientesFueraDeAlcance` |

---

## 6. `export-tenant.mjs` — qué es y qué no

Es un **export de portabilidad, parcial y NO restaurable**. Sirve para pedidos de portabilidad de
datos (privacidad) y para soporte. **No es un backup**, y creer lo contrario es peor que no tener
nada.

Por qué no es restaurable: enumera 15 colecciones a mano (se saltea **sesiones**, **mensajes** e
**ítems de pedido**, que son subcolecciones), no lleva el **ciphertext de `secrets/`** —un restore
dejaría las conexiones Meta muertas—, no lleva **`metaExternalIndex`** —el ruteo del inbound—, no
lleva identidad ni claims, y **degrada los tipos** (`Timestamp`, `GeoPoint` y `Bytes` salen como
mapas anónimos).

Se le agregaron tres guardas baratas y salida con error:

```bash
node apps/functions/scripts/export-tenant.mjs \
  --tenant <id> --project <projectId> --out /d/exports/<id>.json [--include-private]
```

- sin `--tenant` **aborta** (antes tenía un tenant hardcodeado como default);
- el entorno se **declara** (`FIRESTORE_EMULATOR_HOST` o `GOOGLE_APPLICATION_CREDENTIALS`, nunca los
  dos): antes caía al emulador en silencio;
- `--out` tiene que ser **absoluto y fuera del repo** (antes escribía en el cwd, con datos de
  clientes, sin `.gitignore` que lo cubriera);
- **exit ≠ 0** si el tenant no existe o el export sale vacío.

> ⚠️ **Cambio de contrato con consecuencia conocida**: la forma posicional
> `export-tenant.mjs <tenantId> <salida.json>` ya no existe. **`apps/functions/scripts/verify-fase6.mjs`
> la sigue usando y va a fallar hasta que se lo actualice** a la forma con flags (ese archivo no
> pertenece a esta etapa y no se tocó). La herramienta rechaza la forma vieja con el comando de
> reemplazo escrito entero, no con un error críptico.

---

## 7. Higiene

- **Nada de esto se loguea**: tokens, teléfonos completos, mensajes, coordenadas, URLs firmadas,
  secretos. Los identificadores van por **huella** (SHA-256 truncado, irreversible).
- **Los directorios de salida y de reporte contienen datos personales.** Borrarlos cuando dejan de
  hacer falta; nunca commitearlos ni subirlos a un bucket compartido.
- Los volcados de emulador de la prueba E2E quedan en el temporal del sistema — borrarlos al cerrar.
