# Arfagi — Guía de Importación y Configuración de Flujos n8n

## Resumen de los 5 Flujos

| Archivo | Nodos | Trigger | Función |
|---|---|---|---|
| `01_sync_catalogo.json` | 7 | Manual + Cron Lunes 3am | Importa CSV → Firestore, normaliza precios PYG |
| `02_ingreso_omnicanal.json` | 15 | Webhook Meta | Valida HMAC, descarga media, Whisper, llama `/api/v1/process` |
| `03_checkout_abandono.json` | 16 | Cron 5min + Webhook | Recupera carritos, procesa comprobantes SIPAP con OCR |
| `04_logistica.json` | 12 | Cron 2min + Webhook | Notifica repartidor + cliente, gestiona entrega |
| `05_postventa_nps.json` | 21 | Cron Hora + Cron Mes | NPS 24hs post-entrega, campañas CRM segmentadas |

---

## PASO 1 — Importar los Workflows en n8n

### Método A: Importar desde archivo (recomendado)

1. Abrí tu instancia n8n → `https://n8n.arfagi.com`
2. Panel izquierdo → **Workflows** → botón **⊕ Add workflow**
3. Menú de tres puntos `···` → **Import from file**
4. Seleccioná el `.json` del flujo
5. Repetí para los 5 archivos **en orden** (01 al 05)

### Método B: Copiar y pegar el JSON

1. Abrí el archivo `.json` en un editor de texto
2. Seleccioná **todo** el contenido (Ctrl+A)
3. En n8n: nuevo workflow → menú `···` → **Import from clipboard**
4. Pegá el JSON y confirmá

> ⚠️ **Importante:** Los flujos se importan como **inactivos** por defecto.
> NO activarlos hasta completar la configuración de variables.

---

## PASO 2 — Configurar Variables de Entorno en n8n

Ir a **Settings** (engranaje inferior izquierdo) → **Variables** → **Add variable**

Crear las siguientes variables (exactamente con estos nombres):

```
ARFAGI_API_URL          https://api.arfagi.com           # URL base del servidor FastAPI (sin barra final)
ARFAGI_API_KEY          [copia de FASTAPI_API_KEY en .env] # 64 caracteres hex
ARFAGI_CATALOGO_CSV_URL https://docs.google.com/...      # URL de exportación CSV de Google Sheets
WA_ACCESS_TOKEN         EAAxxxxx...                      # Token de Sistema de WhatsApp Cloud API
WA_PHONE_NUMBER_ID      12345678901234                   # ID del número en Meta for Developers
META_APP_SECRET         abc123def456...                  # App Secret (Configuración Básica de la App)
OPENAI_API_KEY          sk-...                           # Clave OpenAI para Whisper
REPARTIDOR_WA_NUMERO    595981000000                     # Número WA del repartidor (sin + ni espacios)
```

> Las variables en n8n se usan con `{{ $env.NOMBRE_VARIABLE }}` en los campos de los nodos.

---

## PASO 3 — Registrar el Webhook de Meta (Flujo 2)

### 3.1 URL del webhook
La URL que debés registrar en Meta for Developers es:
```
https://n8n.arfagi.com/webhook/meta-webhook
```

### 3.2 Registro en Meta for Developers
1. Ir a [developers.facebook.com](https://developers.facebook.com) → Tu App → WhatsApp → Configuración
2. En **Webhooks**, clic en **Editar**
3. URL de devolución de llamada: `https://n8n.arfagi.com/webhook/meta-webhook`
4. Token de verificación: **este campo lo valida FastAPI**, no n8n. Es el valor de `META_WEBHOOK_VERIFY_TOKEN` en tu `.env`
5. Suscribirse a los campos: `messages`, `message_deliveries`, `message_reads`

### 3.3 Verificación del handshake
Meta enviará un GET a tu servidor FastAPI para verificar. Asegurate de que esté corriendo:
```bash
curl "https://api.arfagi.com/api/v1/webhook?hub.mode=subscribe&hub.verify_token=TU_TOKEN&hub.challenge=TEST"
# Debe responder: TEST
```

---

## PASO 4 — Aprobar Templates de WhatsApp en Meta Business Suite

Los mensajes proactivos (NPS, campañas, recuperación de carrito) **requieren Templates aprobados**.
El proceso de aprobación tarda entre 30 minutos y 3 días hábiles.

### Templates necesarios

| Nombre exacto del template | Flujo | Categoría | Botón Opt-Out |
|---|---|---|---|
| `arfagi_recuperacion_carrito` | Flujo 3 | UTILITY | ✅ BAJA |
| `arfagi_nps_encuesta` | Flujo 5 | SERVICE | ✅ BAJA |
| `arfagi_campana_lead` | Flujo 5 | MARKETING | ✅ BAJA |
| `arfagi_campana_nuevo` | Flujo 5 | MARKETING | ✅ BAJA |
| `arfagi_campana_vip` | Flujo 5 | MARKETING | ✅ BAJA |

### Cómo crear un template
1. Meta Business Suite → WhatsApp Manager → **Templates de mensajes** → **Crear plantilla**
2. Categoría: UTILITY para transaccionales, MARKETING para campañas
3. El botón de Opt-Out `BAJA` es **obligatorio por política de Meta** para mensajes proactivos
4. Una vez aprobado, el nombre exacto del template debe coincidir con el JSON del flujo

---

## PASO 5 — Activar los Flujos en Orden

```
① Flujo 1 (Sync Catálogo)    → Ejecutar MANUALMENTE primero → verificar que los productos llegan a Firestore
② Flujo 2 (Ingreso Omnicanal) → Activar → probar con mensaje real de WhatsApp
③ Flujo 3 (Checkout/Abandono) → Activar → el cron de 5 min empieza solo
④ Flujo 4 (Logística)         → Activar → el cron de 2 min empieza solo
⑤ Flujo 5 (Post-Venta NPS)    → Activar ÚLTIMO → requiere templates aprobados
```

Para activar cada flujo: abrir el flujo → toggle **Active** (esquina superior derecha).

---

## PASO 6 — Tests de Validación End-to-End

### Test A: Flujo 2 — Simular mensaje de WhatsApp hacia FastAPI
```bash
curl -X POST https://api.arfagi.com/api/v1/process \
  -H "X-API-Key: TU_FASTAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "cliente_id": "wa:595981234567",
    "canal": "whatsapp",
    "mensaje_texto": "Hola, busco un perfume floral femenino para regalo",
    "tipo_media": "text",
    "meta_message_id": "test_001",
    "nombre_cliente": "María Test"
  }'
# Respuesta esperada: { "respuesta_texto": "¡Hola, María!...", "agente_usado": "recepcionista" }
```

### Test B: Flujo 3 — Simular callback Bancard (con firma real)
```bash
# La firma HMAC la genera tu código Python en tools/bancard.py
# En modo MOCK (sin credenciales Bancard), el endpoint acepta un token especial
curl -X POST https://api.arfagi.com/api/v1/payments/bancard/callback \
  -H "Content-Type: application/json" \
  -d '{"operation": {"shop_process_id": "ARFAGI-PEDTEST", "process_id": "123", "currency": "PYG", "amount": "520000", "token": "FIRMA_MD5_REAL", "response_code": "00"}}'
```

### Test C: Verificar health check del servidor
```bash
curl https://api.arfagi.com/health
# Respuesta: { "estado": "saludable", "servicios": { "fastapi": "ok", "firebase": "ok" } }
```

---

## Mapa de URLs de Webhooks n8n

| Flujo | URL del webhook n8n | Quién lo llama |
|---|---|---|
| Flujo 2 | `https://n8n.arfagi.com/webhook/meta-webhook` | Meta (WA / FB / IG) |
| Flujo 3 | `https://n8n.arfagi.com/webhook/sipap-comprobante` | n8n interno (desde Flujo 2) |
| Flujo 4 | `https://n8n.arfagi.com/webhook/entrega-confirmada` | Repartidor (link simple) |
| Flujo 5 | `https://n8n.arfagi.com/webhook/nps-respuesta` | Flujo 2 al detectar respuesta NPS |

---

## Endpoints FastAPI usados por los Flujos n8n

| Endpoint | Método | Flujo | Implementado en |
|---|---|---|---|
| `/api/v1/process` | POST | 2, 5 | `api/v1/agents.py` ✅ |
| `/api/v1/webhook` | GET | — | `api/v1/webhooks.py` ✅ |
| `/api/v1/payments/bancard/callback` | POST | 3 | `api/v1/payments.py` ✅ |
| `/api/v1/payments/sipap/comprobante` | POST | 3 | `api/v1/payments.py` ✅ |
| `/api/v1/payments/pedido/{id}` | GET | 4 | `api/v1/payments.py` ✅ |
| `/api/v1/storage/upload` | POST | 2, 3 | `services/storage_service.py` 🔲 Bloque 5 |
| `/api/v1/catalogo/sync` | POST | 1 | `api/v1/catalogo.py` 🔲 Bloque 5 |
| `/api/v1/pedidos/abandonados` | GET | 3 | `api/v1/pedidos.py` 🔲 Bloque 5 |
| `/api/v1/pedidos/liberar-locks-expirados` | POST | 3 | `api/v1/pedidos.py` 🔲 Bloque 5 |
| `/api/v1/pedidos/marcar-notificado` | POST | 3 | `api/v1/pedidos.py` 🔲 Bloque 5 |
| `/api/v1/pedidos/estado` | POST | 4 | `api/v1/pedidos.py` 🔲 Bloque 5 |
| `/api/v1/pedidos/pendientes-nps` | GET | 5 | `api/v1/pedidos.py` 🔲 Bloque 5 |
| `/api/v1/pedidos/nps-enviado` | POST | 5 | `api/v1/pedidos.py` 🔲 Bloque 5 |
| `/api/v1/pedidos/guardar-nps` | POST | 5 | `api/v1/pedidos.py` 🔲 Bloque 5 |
| `/api/v1/clientes/{id}/opt-out` | GET | 5 | `api/v1/clientes.py` 🔲 Bloque 5 |
| `/api/v1/clientes/campanas-mensuales` | GET | 5 | `api/v1/clientes.py` 🔲 Bloque 5 |
| `/api/v1/alertas/humana` | POST | 2 | `api/v1/alertas.py` 🔲 Bloque 5 |
| `/api/v1/alertas` | GET | 4 | `api/v1/alertas.py` 🔲 Bloque 5 |

> ✅ Ya implementado en Bloques 2–4  
> 🔲 Pendiente — se codifican en el Bloque 5 (endpoints de soporte para n8n y Flutter)

---

## Troubleshooting Frecuente

### ❌ "El webhook Meta no recibe mensajes"
- Verificar que el SSL de `n8n.arfagi.com` es válido (Meta exige HTTPS)
- Confirmar que el puerto 443 está abierto en el firewall del servidor
- Revisar en Meta Developers que el webhook muestra ✅ verde en el estado

### ❌ "Error HMAC en el Flujo 2 (Validar Firma Meta)"
- Verificar que `META_APP_SECRET` en n8n es exactamente igual al App Secret de Meta Developers
- El body debe ser el JSON crudo sin modificar antes de calcular el HMAC

### ❌ "Flujo 5 no envía mensajes de campaña"
- Verificar que los Templates están aprobados en Meta Business Suite
- El nombre del template en el JSON debe coincidir EXACTAMENTE (sensible a mayúsculas)
- Verificar que los clientes tienen `opt_out=false` en Firestore

### ❌ "Whisper no transcribe el audio"
- Verificar que `OPENAI_API_KEY` tiene créditos disponibles
- El audio de WhatsApp viene en formato `.ogg` — Whisper lo acepta directamente
- Timeout: los audios largos pueden tardar más de 30s → aumentar timeout del nodo

### ❌ "El cron del Flujo 3 detecta falsos abandonados"
- Verificar que el endpoint `/api/v1/pedidos/abandonados` filtra correctamente por `notificado_at=null`
- El Cart Lock es de 45 min; el alerta se envía a los 40 min (5 min antes)
