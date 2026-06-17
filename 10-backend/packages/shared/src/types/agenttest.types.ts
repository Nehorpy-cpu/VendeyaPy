/**
 * Casos de prueba del agente (Simulador, P17). El dueño guarda escenarios y los
 * corre contra el bot para ver cómo responde. Subcolección:
 * tenants/{t}/agentTestCases/{testId}.
 */

import type { AgentTestStatus } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface AgentTestCase {
  id: string;
  tenantId: string;
  name: string;
  /** Descripción del escenario (ej: "Cliente pide descuento"). */
  scenario: string;
  /** Lo que "escribe" el cliente al bot. */
  userMessage: string;
  /** Qué debería hacer/responder el bot. */
  expectedBehavior: string;
  /** Última respuesta real del bot al correr el caso. */
  lastResult: string;
  lastRunAt: Timestamp | null;
  status: AgentTestStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
