/**
 * Middleware de autenticación para Cloud Functions HTTP.
 * Verifica el JWT de Firebase Auth y extrae custom claims.
 * Ver ARCHITECTURE.md §5.
 */

import type { Request } from 'firebase-functions/v2/https';
import { auth } from '../lib/firebase.js';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';
import type { UserRole } from '@vpw/shared';

export interface AuthContext {
  uid: string;
  email: string | undefined;
  tenantId: string | null;
  role: UserRole;
}

export async function verifyAuth(req: Request): Promise<AuthContext> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing Bearer token');
  }
  const token = header.slice('Bearer '.length);
  const decoded = await auth().verifyIdToken(token);

  const role = decoded['role'] as UserRole | undefined;
  if (!role) {
    throw new ForbiddenError('User has no role assigned');
  }

  return {
    uid: decoded.uid,
    email: decoded.email,
    tenantId: (decoded['tenantId'] as string | null) ?? null,
    role,
  };
}

export function requireRole(ctx: AuthContext, allowedRoles: UserRole[]): void {
  if (!allowedRoles.includes(ctx.role)) {
    throw new ForbiddenError(
      `Role ${ctx.role} is not allowed. Required one of: ${allowedRoles.join(', ')}`,
    );
  }
}

export function requireTenant(ctx: AuthContext, tenantId: string): void {
  if (ctx.role === 'PLATFORM_ADMIN') return;
  if (ctx.tenantId !== tenantId) {
    throw new ForbiddenError('You can only access your own tenant');
  }
}
