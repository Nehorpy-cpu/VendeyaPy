# ADR-0004 — Hosting híbrido + WordPress/WooCommerce como fuente del catálogo

**Fecha:** 2026-06-15
**Estado:** Aceptada
**Decisores:** Owner del proyecto

---

## ⚠️ CORRECCIÓN (2026-06-16) — la tienda NO es WooCommerce

Al revisar los archivos reales de la tienda (`TUTORIAL_PASO_A_PASO.md` del deploy a Hostinger)
se confirmó que `arfagi.com` **NO es WordPress/WooCommerce**, sino una **aplicación PHP a
medida con base de datos MySQL** (`arfagi_php`, desarrollada en WAMP). Evidencia: `config/
config.production.php` con `DB_HOST/DB_NAME/DB_USER`, tablas propias (`products`, `categories`,
`orders`, `order_items`, `users`, `cart`, `settings`), panel `/admin` propio, `install_production.php`,
export/import por phpMyAdmin. (Bonus: ya tenían WhatsApp por **UltraMsg**, no oficial.)

**Qué sigue válido:** la decisión de fondo (arquitectura híbrida — tienda en Hostinger como
fuente del catálogo + bot en Firebase) **se mantiene**.

**Qué cambia:** NO hay REST API de WooCommerce. La sincronización del catálogo (MySQL `products`)
se hará por una de estas vías (a decidir al llegar): **(A)** export de la tabla `products` →
nuestro importador CSV ya existente; **(B)** endpoint JSON `api/products.php` agregado a la app PHP;
**(C)** lectura directa de MySQL (⚠️ Hostinger compartido suele bloquear MySQL remoto).

> Todas las menciones a "WooCommerce / WooCommerce REST API" más abajo quedan **superadas** por
> esta corrección (se conservan como registro histórico del supuesto original).

---

## Contexto

El owner tiene en **Hostinger** (plan hosting compartido básico):
- Una **tienda online hecha en WordPress** (sin suscripción extra → muy probablemente **WooCommerce**, el plugin gratuito).
- Sus productos (perfumes) ya cargados ahí: nombres, precios, fotos, stock.

Surgió la pregunta de si alojar la base de datos / el sistema en Hostinger.

Hechos técnicos relevantes:
- El backend del bot (Cloud Functions + Firestore, ver ADR-0001) corre en **Firebase/Google**, no se puede mudar a Hostinger.
- El hosting compartido básico **no es apto** para correr un bot Node.js always-on que reciba webhooks de WhatsApp 24/7 (requeriría upgrade a Business/Cloud/VPS + administración del servidor).
- WooCommerce expone una **REST API** → permite traer productos automáticamente.

## Decisión

**Arquitectura híbrida:**

| Componente | Dónde vive | Rol |
|---|---|---|
| Tienda WordPress/WooCommerce | **Hostinger** (se queda) | **Fuente de verdad del catálogo** — el owner carga/edita productos acá, como ya hace |
| Backend del bot (Cloud Functions) + DB operativa (Firestore) | **Firebase** | Atiende WhatsApp 24/7, conversaciones, pedidos en curso |
| Catálogo en el bot | Firestore (`tenants/perfumeria/products`) | **Espejo sincronizado** desde WooCommerce + datos enriquecidos (notas olfativas, estilos) |

- Se mantiene Firebase (ADR-0001 sigue vigente — **sin retrabajo de F2**).
- La tienda y el bot **conviven**: distinto proveedor, coordinan vía API.
- **No** se migra todo a Hostinger (evita upgrade de plan + administración de servidor para un owner no técnico).

## Implicancia: sincronización del catálogo

- **Fuente primaria:** WooCommerce REST API → trae nombre, precio, stock, imágenes, descripción.
- **Enriquecimiento:** los datos que WooCommerce normalmente NO tiene (notas olfativas salida/corazón/fondo, estilos, familia olfativa, rango) se completan aparte — vía la planilla CSV (ver `70-perfumeria/catalogo/`) o, a futuro, campos personalizados en WooCommerce.
- El importador CSV (F2.4) pasa a ser **vía secundaria / de enriquecimiento**, no la principal.
- La sincronización WooCommerce → Firestore se diseña como sub-fase cuando lleguemos al catálogo real (probablemente alrededor de F3/F5).

## Consecuencias

**Positivas:**
- El catálogo ya está cargado (en la tienda) → el owner no recarga nada a mano.
- Cero costo fijo nuevo relevante (Firebase capa gratuita; Hostinger ya se paga).
- Sin servidor que administrar (Firebase serverless).
- No rompe el diseño de datos de F2.

**Negativas / pendientes:**
- Hay que construir la sincronización WooCommerce → Firestore (API).
- Las notas olfativas/estilos no están en la tienda → se cargan/mantienen aparte.
- El catálogo queda "espejado" en dos lados (tienda = fuente, Firestore = copia para el bot); hay que definir cada cuánto sincroniza.

## Estado del dominio / hosting (2026-06-16)

- **Registrador previo de `arfagi.com`:** Spaceship, Inc.
- **Transferencia del DOMINIO** Spaceship → Hostinger: **en curso** (el sitio WordPress ya
  estaba en Hostinger; esto es solo el traslado de la registración del nombre).
- **Incidencia durante la transferencia:** el sitio dejó de ser accesible vía `arfagi.com`.
  Hostinger muestra "El dominio no está conectado a tu sitio web → conectá tu dominio".
  Causa: la transferencia reinició el apuntado (DNS/nameservers); falta re-enlazar el dominio
  con el sitio en el panel de Hostinger ("Conectar dominio"). El contenido del sitio NO se
  perdió — es un tema de routing. **Acción del owner** (no del proyecto): conectar el dominio
  y esperar propagación DNS; no cambiar nameservers salvo que Hostinger lo indique.

## Pendiente de confirmar

- [ ] Reconectar `arfagi.com` al sitio en Hostinger (owner) y verificar que vuelve a abrir.
- [x] Identificar la tecnología de la tienda → **app PHP a medida + MySQL** (`arfagi_php`). Ver corrección arriba.
- [ ] Elegir la vía de sincronización del catálogo MySQL → Firestore (A export CSV / B endpoint JSON / C MySQL remoto).
- [ ] Acceso necesario: credenciales MySQL de Hostinger (`DB_NAME/DB_USER/DB_PASS`) o export de la tabla `products`.

## Reversibilidad

Media. Si en el futuro se quisiera todo en Hostinger, se evaluaría el Camino B (Node+MySQL en
plan Business/VPS) — implicaría reescribir backend y migrar datos. No es la dirección elegida hoy.
