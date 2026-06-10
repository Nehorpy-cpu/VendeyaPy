# Contribuir a VentaporWhatsapp

## Antes de empezar

1. Leer [ARCHITECTURE.md](./ARCHITECTURE.md) completo.
2. Identificar a qué bloque del roadmap pertenece tu trabajo (§10).
3. Verificar que no rompa convenciones de nombres (§3).

## Flujo de trabajo

1. Crear branch desde `main`: `feat/<bloque>-<descripcion>` o `fix/<descripcion>`
2. Implementar siguiendo la arquitectura
3. Agregar tests (ver §8 para cobertura mínima)
4. Abrir PR contra `main`
5. CI debe pasar en verde
6. Tras review aprobado → merge

## Convenciones

### Commits

Usar conventional commits:

```
feat(orders): agregar endpoint para cancelar orden
fix(whatsapp): corregir verificación de firma
docs(arch): aclarar flujo de pagos Bancard
refactor(shared): mover Address a common.types
test(payments): cubrir caso de webhook duplicado
chore: actualizar deps
```

### Branches

```
feat/B3-conversation-router       (bloque 3, feature)
fix/payment-bancard-timeout       (bug fix)
chore/upgrade-firebase-v12        (mantenimiento)
docs/architecture-update          (solo docs)
```

### Tipos TypeScript

- Toda entidad de datos: archivo `*.types.ts` en `packages/shared/src/types/`
- Tipos locales de una función: en el mismo archivo o `*.types.ts` colocado
- NUNCA duplicar tipos entre paquetes

### Cloud Functions

- Una function = un archivo en `apps/functions/src/functions/<dominio>/`
- Exportar desde `apps/functions/src/index.ts`
- Patrón de naming: `{dominio}{Accion}` (camelCase)
- Cada function debe validar auth o firma según corresponda

### Firestore

- Toda escritura crítica de negocio (órdenes, pagos, entregas) va por Cloud Functions
- Reglas de seguridad deben actualizarse en `firestore.rules` cuando se agrega una colección
- Índices compuestos van en `firestore.indexes.json`

## Setup local

Ver [README.md](./README.md#setup-local).

## Preguntas

Abrir un issue con label `question`.
