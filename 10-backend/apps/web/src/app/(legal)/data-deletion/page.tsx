import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, Section, P, UL, LEGAL_CONTACT_EMAIL } from '@/components/legal/ui';

export const metadata: Metadata = {
  title: 'Eliminación de datos — VendeYaPy',
  description: 'Cómo una empresa o usuario puede solicitar la eliminación de sus datos en VendeYaPy.',
};

export default function DataDeletionPage() {
  return (
    <LegalPage
      title="Eliminación de datos"
      intro="Podés solicitar la eliminación de los datos asociados a tu cuenta y a tu empresa en VendeYaPy. Acá te explicamos qué se elimina y cómo pedirlo."
    >
      <Section title="1. Qué datos podés eliminar">
        <UL
          items={[
            'Datos de tu cuenta y de tu empresa (perfil, configuración, catálogo).',
            'Conversaciones y datos de clientes finales gestionados en la plataforma.',
            'Pedidos, seguimientos y registros asociados a tu empresa.',
            'La conexión con Meta/WhatsApp y los tokens de acceso guardados.',
          ]}
        />
      </Section>

      <Section title="2. Cómo solicitar la eliminación">
        <P>Enviá una solicitud por cualquiera de estos medios:</P>
        <UL
          items={[
            <>
              Por correo a{' '}
              <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="font-medium text-mint-700 hover:text-mint-800">
                {LEGAL_CONTACT_EMAIL}
              </a>{' '}
              con el asunto «Eliminación de datos».
            </>,
            'Por nuestro canal de WhatsApp de soporte.',
          ]}
        />
        <P>
          Para poder procesar el pedido, indicanos el <strong>correo de la cuenta</strong> y el{' '}
          <strong>nombre de la empresa</strong>. Podemos pedirte una verificación para confirmar que sos
          titular de la cuenta y proteger los datos de terceros.
        </P>
      </Section>

      <Section title="3. Qué hacemos al recibir tu solicitud">
        <UL
          items={[
            'Confirmamos la titularidad de la cuenta.',
            'Desconectamos la integración con Meta/WhatsApp y revocamos los tokens guardados.',
            'Eliminamos los datos de tu empresa, clientes y conversaciones de nuestros sistemas de producción.',
            'Te confirmamos cuando la eliminación se completó.',
          ]}
        />
      </Section>

      <Section title="4. Plazos">
        <P>
          Buscamos procesar las solicitudes en un plazo razonable, normalmente dentro de los 30 días de
          verificada la titularidad. Si necesitáramos más tiempo, te lo informaremos.
        </P>
      </Section>

      <Section title="5. Datos que pueden conservarse">
        <P>
          Algunos datos pueden conservarse por un período adicional cuando una obligación legal, contable o de
          seguridad lo requiera, o en copias de respaldo que se sobrescriben con el tiempo. En esos casos, los
          datos se mantienen limitados a ese fin y luego se eliminan.
        </P>
      </Section>

      <Section title="6. Datos en Meta/WhatsApp">
        <P>
          Esta solicitud cubre los datos almacenados en VendeYaPy. Los datos que existan directamente en tu
          cuenta de Meta/WhatsApp se gestionan desde las herramientas de Meta; podés revisar la{' '}
          <Link href="/privacy" className="font-medium text-mint-700 hover:text-mint-800">
            política de privacidad
          </Link>{' '}
          para más detalle sobre esa integración.
        </P>
      </Section>
    </LegalPage>
  );
}
