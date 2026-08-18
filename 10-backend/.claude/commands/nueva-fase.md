---
description: Audita el estado y redacta el prompt técnico completo de la próxima fase (rol de coordinador)
argument-hint: [nombre o descripción de la fase, o vacío para que la proponga]
allowed-tools: Read, Grep, Glob, Bash(git log:*), Bash(git status:*), Bash(git diff:*), Agent(coordinador)
disable-model-invocation: true
---

# Coordinación de fase

## Contexto

- Estado actual: @docs/ESTADO.md
- Reglas del proyecto: @AGENTS.md
- Últimos commits: !`git log --oneline -10`
- Árbol de trabajo: !`git status --short`

## Tu tarea

Delegá esta fase al subagente `coordinador`. **No implementes nada en este turno** — este
comando produce un prompt, no código. Si te encontrás editando un archivo del producto,
te saliste del comando.

Fase pedida por el owner: **$ARGUMENTS**

Si `$ARGUMENTS` está vacío, proponé las tres candidatas más razonables según los bloqueantes
abiertos de `ESTADO.md`, con una línea de justificación cada una, y pará ahí. No elijas vos.

## Qué debe producir el coordinador

Un prompt técnico completo, listo para pegar en una sesión limpia de Claude Code, con esta
estructura exacta:

### 1. Encuadre

Qué es el sistema, en qué tenant y superficie toca esta fase, y qué NO entra en el alcance.
El alcance negativo es tan importante como el positivo: este proyecto se rompe por cambios
oportunistas, no por cambios insuficientes.

### 2. Fase 0 — Auditoría obligatoria antes de escribir código

Qué archivos y qué contratos hay que leer y confirmar antes de tocar nada. Preguntas concretas
que la auditoría debe responder. Prohibición explícita de modificar durante la fase 0.

### 3. Estado de partida verificable

Los números y hechos de `ESTADO.md` que esta fase da por ciertos, y **cuáles hay que
reverificar contra producción antes de empezar**. Todo lo marcado `⚠️ verificar` va acá.

### 4. Requisitos, con sus invariantes

Qué debe hacer el cambio. Por cada requisito, el invariante que no se puede violar:
fail-closed, idempotencia, aislamiento multi-tenant, la IA jamás decide dinero, ningún camino
mueve un pedido sin autorización humana, cero hard-delete.

### 5. Riesgos y dependencias

Qué puede romper esto, qué depende de un gate externo (Meta, el feed, el owner), y cuál es la
condición de parada fail-closed: en qué situación la sesión **debe detenerse sin mutar nada**
y pedir decisión del owner.

### 6. Verificación exigida

Qué suites, qué E2E, qué regresiones. Si corresponde review adversarial, decir con qué foco.
El criterio de aceptación se escribe en números, no en adjetivos.

### 7. Selector de release propuesto

CREATE / UPDATE / DELETE con nombres, orden de deploy (consumidores primero, productores
último), índices, Rules, Hosting. Y el selector de rollback: el mismo **menos las CREATE**.
Si la fase no llega a deploy, decirlo y explicar qué falta para llegar.

### 8. Formato del reporte de cierre

Recordar los 9 campos y que el cierre se hace con `/cerrar-fase`.

## Al terminar

Devolvé el prompt en un solo bloque copiable, sin comentarios tuyos alrededor. Después del
bloque, agregá como máximo tres líneas: qué asumiste, qué no pudiste verificar y qué decisión
necesita el owner antes de arrancar.
