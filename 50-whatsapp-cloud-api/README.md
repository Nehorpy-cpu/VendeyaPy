# 50 · WhatsApp Cloud API (oficial Meta)

> Canal de WhatsApp del proyecto. **Decisión:** WhatsApp Cloud API oficial de Meta.
> Ver `00-architecture/decisions/ADR-0003-whatsapp-cloud-api.md`.

OpenWA (servidor no oficial) fue **descartado** — quedó archivado en
`_archive/OpenWA-descartado/` por si se necesita para testing local algún día.

---

## Qué va en esta carpeta

| Subcarpeta | Contenido |
|---|---|
| `config/` | Plantillas de configuración del webhook, IDs de Meta (sin secretos), mapeo número→tenant |

> Los **secretos** (access token, app secret, verify token) NUNCA van acá.
> Van en variables de entorno / Firebase config. Ver `.env.example` del backend.

---

## Componentes de la integración (se desarrollan en fase F1)

1. **App de WhatsApp en Meta** — crear en developers.facebook.com
2. **Número dedicado** — registrado en WhatsApp Business API (NO puede ser un WhatsApp personal/Business app normal)
3. **Webhook** — endpoint en Cloud Functions que recibe los mensajes entrantes
4. **Access token** — permanente (System User token), no el temporal de 24h
5. **Verify token** — string propio para validar el webhook con Meta

El código del webhook vive en `10-backend/apps/functions/`, no acá.
Esta carpeta es solo configuración y documentación del canal.
