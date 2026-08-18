---
description: Emite el reporte de 9 campos de la fase y actualiza ESTADO.md y BITACORA.md
argument-hint: [NOMBRE-DEL-PROGRAMA-N]
allowed-tools: Read, Edit, Write, Grep, Glob, Bash(git log:*), Bash(git status:*), Bash(git diff:*), Bash(pnpm:*)
disable-model-invocation: true
---

# Cierre de fase

## Contexto

- Estado vigente: @docs/ESTADO.md
- Bitácora: @docs/BITACORA.md
- Commits de la sesión: !`git log --oneline -5`
- Árbol de trabajo: !`git status --short`

## Tu tarea

Cerrar la fase **$ARGUMENTS**. Tres entregables, en este orden.

### 1. Reporte en pantalla — los 9 campos

1. **Qué se auditó** — archivos y contratos leídos, no una descripción vaga.
2. **Causa raíz** — por qué existía el problema. Si no la encontraste, decilo.
3. **Cambios realizados**
4. **Archivos o módulos afectados**
5. **Tests y regresiones** — números reales por suite. Separar emulador de producción.
6. **Commit** — hash. Si no commiteaste, decir por qué.
7. **Estado de deploy** — casi siempre "NO DESPLEGADO, pendiente de aprobación del owner".
8. **Riesgos o pendientes** — incluidos los defectos ajenos que destapó la fase, con severidad.
9. **Próximo prompt recomendado**

### 2. Entrada nueva en `docs/BITACORA.md`

Arriba de todo, bajo el mes correspondiente, con la plantilla que el propio archivo define.
**Append: no edites ni borres entradas anteriores.** Si esta fase supera un hecho anterior,
marcá la entrada vieja con `[HISTÓRICO — superado por <esta entrada>]` y dejala donde está.

### 3. Reescritura de `docs/ESTADO.md`

`ESTADO.md` describe el presente, así que sí se reescribe. Actualizá:

- último commit desplegado, functions, índices, hash de rules, schedulers
- flags por tenant, si cambiaron
- bloqueantes abiertos: sacá los cerrados, agregá los nuevos
- la tabla "En repo, sin desplegar"
- deudas menores
- la fecha del encabezado

## Regla de honestidad

Si un número no lo verificaste en **esta** sesión, no lo copies: marcalo `⚠️ verificar`.
Arrastrar un número viejo como si fuera fresco es exactamente el defecto que hizo que el
resumen anterior declarara `30c1687` como último commit desplegado cuando ya había dos
deploys posteriores.

Y no declares nada "completo" porque los tests pasan. Completo = validado en producción con
evidencia. Desplegado con el flag apagado se escribe **EN PROD — INERTE**, nunca "activo".
