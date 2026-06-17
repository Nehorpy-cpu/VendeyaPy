/**
 * Configuración del agente de IA, editable por el dueño desde el panel (sin tocar código).
 * Vive en Firestore: tenants/{tenantId}/config/agent.
 */

export interface FaqItem {
  q: string;
  a: string;
}

/** Cuenta bancaria a la que el cliente transfiere (datos para compartir, no secretos). */
export interface BankAccount {
  bank: string;
  accountNumber: string;
  holder: string;
  document: string; // CI o RUC
  alias?: string;
}

/** Vendedor al que se deriva la venta (handoff). */
export interface Seller {
  name: string;
  whatsapp: string; // E.164
  active: boolean;
}

export interface CheckoutConfig {
  bankAccounts: BankAccount[];
  sellers: Seller[];
}

export interface AgentConfig {
  agentName: string; // "Sofía"
  businessName: string; // "Perfumería AFG"
  tone: string; // amable, profesional, cercano, vendedor...
  language: string; // "es"
  greetingMessage: string; // saludo inicial (vacío = usar el default)
  farewellMessage: string;
  fallbackMessage: string; // cuando no entiende
  handoffMessage: string; // al derivar a vendedor
  salesRules: string; // reglas de venta en texto libre (las usará el cerebro de IA real)
  faq: FaqItem[];
  botEnabled: boolean; // apagar/encender el bot
  testMode: boolean; // modo prueba
}
