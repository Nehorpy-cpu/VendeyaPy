/**
 * Usuarios admin de la plataforma.
 * Ver ARCHITECTURE.md §4.9 y §5.
 */

import type { UserRole } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface User {
  /** Firebase Auth UID */
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** null solo para PLATFORM_ADMIN */
  tenantId: string | null;
  createdAt: Timestamp;
  lastLoginAt: Timestamp;
}

/**
 * Custom claims que se setean en el JWT de Firebase Auth.
 * Ver ARCHITECTURE.md §5.3.
 */
export interface AuthCustomClaims {
  tenantId: string | null;
  role: UserRole;
}
