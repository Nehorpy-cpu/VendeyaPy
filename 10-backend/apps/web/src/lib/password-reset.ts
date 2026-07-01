/**
 * Recuperación de contraseña (PASSWORD-RESET-UX). Lógica pura y testeable del flujo de
 * `sendPasswordResetEmail` de Firebase Auth: validación de email + mapeo seguro de errores.
 *
 * SEGURIDAD: nunca se revela si el correo existe. Ante éxito O `auth/user-not-found` se muestra
 * el MISMO mensaje genérico. Solo errores operativos (email inválido / demasiados intentos / red)
 * muestran un mensaje específico; cualquier otro cae a un fallback genérico.
 */

/** Mensaje genérico y seguro (no revela existencia de la cuenta). Igual para éxito y user-not-found. */
export const RESET_GENERIC_MESSAGE =
  'Si existe una cuenta con ese correo, te enviaremos un enlace para restablecer tu contraseña.';

/** Validación básica de formato de email (no verifica existencia). */
export function isValidEmail(email: string): boolean {
  const e = email.trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254;
}

export type ResetOutcome =
  | { kind: 'success'; msg: string }
  | { kind: 'error'; msg: string };

/**
 * Traduce el resultado de `sendPasswordResetEmail` a un desenlace de UI.
 * `code` es el `FirebaseError.code` (ej. 'auth/too-many-requests'); '' para el caso de éxito.
 */
export function resetOutcome(code: string): ResetOutcome {
  switch (code) {
    // Éxito real, o cuenta inexistente: MISMO mensaje genérico (no revelar existencia).
    case '':
    case 'auth/user-not-found':
    case 'auth/missing-email':
      return { kind: 'success', msg: RESET_GENERIC_MESSAGE };
    case 'auth/invalid-email':
      return { kind: 'error', msg: 'Ingresá un email válido.' };
    case 'auth/too-many-requests':
      return { kind: 'error', msg: 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.' };
    case 'auth/network-request-failed':
      return { kind: 'error', msg: 'Problema de conexión. Revisá tu internet e intentá de nuevo.' };
    default:
      return { kind: 'error', msg: 'No pudimos procesar la solicitud. Intentá de nuevo en un momento.' };
  }
}
