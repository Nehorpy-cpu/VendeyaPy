# VentaporWhatsapp

Plataforma SaaS de comercio por WhatsApp para Latinoamérica.

> **Documento de referencia obligatorio:** [ARCHITECTURE.md](./ARCHITECTURE.md)
> Toda decisión técnica debe ser consistente con ese documento.

---

## Stack

- **Frontend (panel admin):** Next.js 14 + Tailwind
- **Backend:** Firebase Cloud Functions (Node.js 20 + TypeScript)
- **Base de datos:** Cloud Firestore (multi-tenant)
- **Autenticación:** Firebase Authentication
- **Orquestación:** n8n (self-hosted en Cloud Run)
- **Mensajería:** Meta WhatsApp Cloud API
- **Pagos:** Stripe + Bancard + Tigo Money + Personal Pay + Zimple

---

## Estructura

```
ventaporwhatsapp/
├── apps/
│   ├── web/                  # Panel admin (Next.js)
│   └── functions/            # Cloud Functions (API + webhooks)
├── packages/
│   ├── shared/               # Tipos TypeScript compartidos
│   ├── firebase-config/      # Reglas e índices de Firestore
│   └── n8n-workflows/        # Workflows n8n exportados
├── tests/                    # Unit, integration y E2E
├── .github/workflows/        # CI/CD
├── firebase.json             # Config Firebase
├── firestore.rules           # Reglas de seguridad
├── firestore.indexes.json    # Índices compuestos
└── ARCHITECTURE.md           # Fuente única de verdad
```

---

## Setup local

### Requisitos

- Node.js 20+
- pnpm 8+
- Firebase CLI (`npm install -g firebase-tools`)
- Java JRE 11+ (para emuladores Firebase)

### Instalación

```bash
# Instalar dependencias del monorepo
pnpm install

# Copiar variables de entorno
cp .env.example .env.local
# Editar .env.local con tus credenciales

# Login en Firebase
firebase login
firebase use vpw-dev
```

### Desarrollo

```bash
# Iniciar emuladores (Firestore, Auth, Functions, Storage, Pub/Sub)
pnpm emulators

# En otra terminal, iniciar el panel web
pnpm --filter web dev

# Acceder a:
# - Panel admin: http://localhost:3000
# - Emulator UI: http://localhost:4000
# - Functions: http://localhost:5001
```

---

## Pruebas

```bash
# Todas las pruebas
pnpm test

# Solo unit
pnpm test:unit

# Integration (requiere emulators corriendo)
pnpm test:integration

# E2E
pnpm test:e2e
```

---

## Deploy

```bash
# Staging (automático en merge a main)
pnpm deploy:staging

# Producción (manual, requiere tag v*.*.*)
pnpm deploy:prod
```

---

## Roadmap

Ver bloques de trabajo en [ARCHITECTURE.md §10](./ARCHITECTURE.md#10-roadmap-de-bloques).

**Bloque actual:** 0 — Fundación.

---

## Contribuir

1. Leer `ARCHITECTURE.md` completo antes de abrir un PR.
2. Respetar las convenciones de nombres (§3).
3. Mantener cobertura de tests mínima (§8.6).
4. Toda nueva entidad de datos debe agregarse a `packages/shared/src/`.
5. Toda nueva Cloud Function debe seguir el patrón `{dominio}{Accion}` en camelCase.

---

## Licencia

Propietario — VentaporWhatsapp. Todos los derechos reservados.
