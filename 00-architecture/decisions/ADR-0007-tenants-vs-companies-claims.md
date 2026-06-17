# ADR-0007 — Mantener `tenants/{tenantId}` + membresía por custom claims (no `companies/{companyId}` ni `members/`)

**Fecha:** 2026-06-17
**Estado:** Aceptada
**Decisores:** Owner del proyecto

---

## Contexto

Un spec posterior (generado por ChatGPT, sin contexto completo del proyecto) propone la estructura
`companies/{companyId}/...` y resolver la membresía/rol con una subcolección
`companies/{companyId}/members/{userId}` leída dentro de las reglas con `get()`/`exists()`.

Nuestro proyecto **ya está construido** (P1–P5) sobre:
- Raíz multi-empresa: **`tenants/{tenantId}/...`**
- Identidad y rol del usuario: **Firebase Auth custom claims** `{ tenantId, role }` (seteados por
  Cloud Functions con Admin SDK), validados en las reglas con `request.auth.token.*`.

## Decisión

1. **No renombrar `tenants` → `companies`.** Son el mismo concepto ("empresa"). Renombrar obligaría
   a migrar colecciones, reglas, índices, tipos, seeders y todo el código de `apps/web` y
   `apps/functions` sin ningún beneficio funcional. **Se mantiene `tenants/{tenantId}`.**
   "Company" es solo el nombre que ve el usuario en la UI; `tenantId` es el identificador técnico.
2. **Mantener membresía por custom claims**, no por subcolección `members/` leída en reglas.
   Las reglas usan `request.auth.token.tenantId` y `request.auth.token.role` (lecturas de token,
   **costo cero** en reglas).
3. **`members/` solo si la UI lo necesita.** Si más adelante hace falta listar/administrar usuarios
   de una empresa desde el panel, se puede agregar una colección de lectura `tenants/{t}/members`
   (o usar la colección global `users`), pero **las reglas seguirán validando por claims**, no por
   `get()` a `members`.

## Por qué

- El propio spec advierte que Firestore **limita la cantidad de `get()`/`exists()` dentro de
  reglas** y que conviene mantenerlas simples. Los custom claims evitan por completo esas lecturas:
  el rol y el tenant viajan en el token ya verificado. Es **más barato y más rápido** que `members/`.
- Renombrar a `companies` es puro costo y riesgo de romper lo que ya funciona (regla de oro del
  owner: no romper el proyecto).

## Equivalencia de nombres (para leer el spec sin confundirse)

| Spec (ChatGPT) | Nuestro proyecto |
|---|---|
| `companies/{companyId}` | `tenants/{tenantId}` |
| `members/{userId}` (rol en doc) | custom claims `{ tenantId, role }` + colección global `users/{uid}` |
| `platformRole == "super_admin"` | `role == 'PLATFORM_ADMIN'` |
| `role == "owner"` | `role == 'TENANT_OWNER'` |
| `role == "seller"` | `role == 'SELLER'` |

## Consecuencias

**Positivas:** no se rompe nada de P1–P5; reglas baratas; menos lecturas. **Negativas:** hay que
"traducir" mentalmente los nombres del spec al leerlo (esta tabla queda como referencia). Ver
ADR-0005 (panel multiempresa) y ADR-0008 (separación de datos financieros).
