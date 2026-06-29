import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, Section, P, UL, LEGAL_LAST_UPDATED } from '@/components/legal/ui';

export const metadata: Metadata = {
  title: 'Términos del servicio — VendeYaPy',
  description: 'Condiciones de uso de la plataforma VendeYaPy para vender por WhatsApp y gestionar el negocio.',
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Términos del servicio"
      note={
        <>
          <strong className="font-semibold text-ink-800">Última actualización:</strong> {LEGAL_LAST_UPDATED}.
          Estos términos describen las condiciones de uso de la plataforma VendeYaPy. Podremos actualizarlos
          periódicamente para reflejar cambios en el servicio, requisitos legales o políticas de plataformas
          integradas como Meta/WhatsApp.
        </>
      }
      intro="Estos términos regulan el uso de VendeYaPy. Al crear una cuenta o usar la plataforma, aceptás estas condiciones. Si usás la plataforma en nombre de una empresa, declarás tener facultades para aceptarlas por ella."
    >
      <Section title="1. El servicio">
        <P>
          VendeYaPy ofrece un panel y un bot para vender por WhatsApp, gestionar catálogo, pedidos, clientes y
          conversaciones, y —cuando se conecta Meta— medir campañas. El servicio se ofrece «tal cual» y puede
          cambiar, mejorar o suspender funciones con aviso razonable.
        </P>
      </Section>

      <Section title="2. Cuenta y responsabilidades del usuario">
        <UL
          items={[
            'Proporcionar datos veraces y mantener la seguridad de tus credenciales.',
            'Usar la plataforma de forma lícita y respetando los derechos de terceros.',
            'No usar el servicio para spam, fraude ni contenidos prohibidos.',
            'Gestionar los permisos de tu equipo y el acceso por roles dentro de tu empresa.',
          ]}
        />
      </Section>

      <Section title="3. Datos de tus clientes">
        <P>
          Tu empresa es responsable de los datos de sus clientes finales y de contar con la base legal y el
          consentimiento necesarios para tratarlos por WhatsApp. Vos definís qué mensajes envía el bot y qué
          contenido cargás (catálogo, reglas, respuestas). Nosotros tratamos esos datos en tu nombre para
          prestar el servicio, según la{' '}
          <Link href="/privacy" className="font-medium text-mint-700 hover:text-mint-800">
            política de privacidad
          </Link>
          .
        </P>
      </Section>

      <Section title="4. Integraciones con Meta / WhatsApp">
        <P>
          El uso de WhatsApp y Meta a través de la plataforma está sujeto también a los términos y políticas de
          Meta. Sos responsable de cumplir esas políticas (por ejemplo, las reglas de mensajería de WhatsApp) y
          de mantener tu propia cuenta de Meta en regla.
        </P>
      </Section>

      <Section title="5. Planes y pagos">
        <P>
          La activación de planes es <strong>manual</strong> y se coordina por WhatsApp; el pago se gestiona por
          fuera de la plataforma. Las condiciones de cada plan (límites y precios) se informan al contratarlo y
          pueden actualizarse con aviso.
        </P>
      </Section>

      <Section title="6. Inteligencia artificial">
        <P>
          Algunas respuestas y sugerencias se generan con modelos de IA de terceros. Pueden ser imprecisas o
          contener errores, por lo que deberías revisarlas antes de actuar. No garantizamos un resultado de
          ventas determinado.
        </P>
      </Section>

      <Section title="7. Disponibilidad y garantías">
        <P>
          Hacemos esfuerzos razonables para mantener el servicio disponible y seguro, pero no garantizamos que
          funcione sin interrupciones ni errores. El servicio se brinda «tal cual» y «según disponibilidad»,
          sin garantías implícitas más allá de lo exigido por la ley aplicable.
        </P>
      </Section>

      <Section title="8. Limitación de responsabilidad">
        <P>
          En la medida permitida por la ley, no seremos responsables por daños indirectos o lucro cesante
          derivados del uso o la imposibilidad de uso del servicio. Nada en estos términos limita derechos que
          no puedan limitarse legalmente.
        </P>
      </Section>

      <Section title="9. Suspensión y baja">
        <P>
          Podés dar de baja tu cuenta y solicitar la eliminación de tus datos en cualquier momento (ver{' '}
          <Link href="/data-deletion" className="font-medium text-mint-700 hover:text-mint-800">
            eliminación de datos
          </Link>
          ). Podemos suspender cuentas que incumplan estos términos o las políticas de las plataformas
          integradas.
        </P>
      </Section>

      <Section title="10. Cambios a estos términos">
        <P>
          Podemos actualizar estos términos a medida que el producto evoluciona. Publicaremos la versión vigente
          en esta página con su fecha de actualización.
        </P>
      </Section>
    </LegalPage>
  );
}
