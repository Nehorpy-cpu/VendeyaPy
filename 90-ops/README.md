# 90-ops — Entorno de desarrollo local

Cómo levantar AI_AFG en tu máquina para desarrollar y probar (sin Meta, sin nube).

---

## ⚠️ Requisito de disco: NTFS (no exFAT)

El proyecto **debe vivir en un disco NTFS** (ej. `C:\AI_AFG`). En exFAT (pendrives, algunos
discos externos) fallan los symlinks y la instalación de dependencias. Por eso el proyecto
está en `C:\AI_AFG` y no en `F:`.

---

## Pre-requisitos (instalar una vez)

| Herramienta | Para qué | Instalación |
|---|---|---|
| **Node.js 20+** | Runtime del backend | https://nodejs.org (instalado: v24) |
| **pnpm 9** | Gestor de paquetes del monorepo | `npm install -g pnpm@9` |
| **Java (OpenJDK 21)** | Lo necesita el emulador de Firestore | `winget install Microsoft.OpenJDK.21` |
| **Docker Desktop** | Corre n8n | https://www.docker.com/products/docker-desktop |

### Setup inicial (una vez)

```powershell
# 1. Dependencias del backend
cd C:\AI_AFG\10-backend
pnpm install

# 2. Habilitar el experimento de Firebase (necesario para que arranquen los emuladores)
pnpm exec firebase experiments:enable webframeworks

# 3. Construir el paquete compartido y las functions
pnpm --filter @vpw/shared build
pnpm --filter functions build
```

---

## Levantar el entorno

### Forma fácil (un comando)

```powershell
powershell -ExecutionPolicy Bypass -File 90-ops\dev-up.ps1
```

Levanta n8n (Docker) y los emuladores de Firebase (Firestore + Functions). `Ctrl+C` frena
los emuladores; para apagar n8n: `90-ops\dev-down.ps1`.

### Forma manual

```powershell
# n8n
docker compose -f 90-ops\docker-compose.yml up -d

# Emuladores (en otra terminal, desde 10-backend)
cd C:\AI_AFG\10-backend
pnpm exec firebase emulators:start --only "firestore,functions" --project demo-aiafg
```

---

## Cargar el catálogo (con el emulador corriendo)

```powershell
# 1. Generar el seed desde la planilla
cd C:\AI_AFG\70-perfumeria\catalogo
node import-catalogo.mjs

# 2. Cargarlo al emulador
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
cd C:\AI_AFG\10-backend\apps\functions
node scripts/load-catalog.mjs
```

Verás los productos en la UI del emulador (link abajo).

---

## Puertos

| Servicio | URL | Qué es |
|---|---|---|
| Emulator UI | http://localhost:4000 | Consola visual de Firebase (ver base de datos) |
| Firestore | localhost:8080 | Base de datos local |
| Functions | http://localhost:5001 | Backend (ej. healthCheck) |
| n8n | http://localhost:5678 | Orquestador de workflows |

**Probar el backend:**
`curl http://127.0.0.1:5001/demo-aiafg/us-central1/healthCheck` → `{"status":"ok"}`

---

## Problemas comunes (ya resueltos, por si reaparecen)

| Síntoma | Causa | Solución |
|---|---|---|
| `pnpm install` falla con `EISDIR`/symlink | Disco exFAT | Mover el proyecto a NTFS (C:) |
| `No emulators to start` | En PowerShell la coma se interpreta como lista | Poné el target entre comillas: `--only "firestore,functions"` |
| `ERR_REQUIRE_ASYNC_MODULE` al cargar functions | `await` en la raíz de un módulo | Usar `export { x } from '...'` en vez de `await import()` |
| El emulador no arranca: falta Java | OpenJDK no instalado / no en PATH | `winget install Microsoft.OpenJDK.21` |
| `firebase` no reconoce los emuladores | Falta el experimento | `pnpm exec firebase experiments:enable webframeworks` |

---

## Notas

- Proyecto de emulador: `demo-aiafg` (el prefijo `demo-` = 100% offline, sin credenciales reales).
- El backend es Firebase (ver ADR-0001); n8n orquesta (workflows en `20-n8n/workflows`).
- Hosting de la tienda y catálogo: WordPress/WooCommerce en Hostinger (ver ADR-0004).
