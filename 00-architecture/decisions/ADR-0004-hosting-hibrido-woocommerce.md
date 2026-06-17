# ADR-0004 — Hosting híbrido + WordPress/WooCommerce como fuente del catálogo

**Fecha:** 2026-06-15
**Estado:** Aceptada
**Decisores:** Owner del proyecto

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
- [ ] Confirmar que la tienda es **WooCommerce** (vs otro plugin de tienda WordPress). Se verifica al construir la sincronización.
- [ ] Versión de WordPress/WooCommerce y disponibilidad de la REST API (claves de API).

## Reversibilidad

Media. Si en el futuro se quisiera todo en Hostinger, se evaluaría el Camino B (Node+MySQL en
plan Business/VPS) — implicaría reescribir backend y migrar datos. No es la dirección elegida hoy.
