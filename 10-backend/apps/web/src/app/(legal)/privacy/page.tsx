import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, Section, P, UL, LEGAL_LAST_UPDATED } from '@/components/legal/ui';

export const metadata: Metadata = {
  title: 'Política de privacidad — VendeYaPy',
  description:
    'Cómo VendeYaPy recolecta, usa, comparte y protege los datos de cuentas, empresas, clientes y conversaciones.',
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Política de privacidad"
      note={
        <>
          <strong className="font-semibold text-ink-800">Última actualización:</strong> {LEGAL_LAST_UPDATED}.
          Esta política describe cómo VendeYaPy recopila, utiliza y protege la información relacionada con el
          uso de la plataforma. Podremos actualizarla periódicamente para reflejar cambios en el servicio,
          requisitos legales o políticas de plataformas integradas como Meta/WhatsApp.
        </>
      }
      intro="VendeYaPy es una plataforma para vender por WhatsApp y gestionar el negocio. Esta política describe qué datos tratamos, con qué fin, con quién los compartimos y cómo podés solicitar su eliminación. Aplica a las empresas que usan el panel y a las personas que las representan."
    >
      <Section title="1. Datos de cuenta y empresa">
        <P>Cuando creás una cuenta o una empresa en la plataforma, tratamos datos como:</P>
        <UL
          items={[
            'Datos de la persona usuaria: nombre, correo electrónico, teléfono y rol dentro de la empresa.',
            'Datos de la empresa: nombre del negocio, país, moneda, configuración del agente, catálogo de productos y precios.',
            'Datos de uso: acciones dentro del panel y registros técnicos necesarios para operar el servicio.',
          ]}
        />
      </Section>

      <Section title="2. Datos de clientes y conversaciones">
        <P>
          La plataforma procesa las conversaciones que tu empresa mantiene con sus clientes finales por
          WhatsApp, incluyendo:
        </P>
        <UL
          items={[
            'Mensajes entrantes y salientes, y el historial de la conversación.',
            'Datos de contacto del cliente final (por ejemplo, número de WhatsApp) y los pedidos asociados.',
            'Estado de la venta (pedidos, pagos coordinados, seguimientos).',
          ]}
        />
        <P>
          Estos datos pertenecen a tu empresa y los tratamos en su nombre para prestar el servicio. Tu empresa
          es responsable de informar a sus clientes y de contar con la base legal para tratar esos datos.
        </P>
      </Section>

      <Section title="3. Conexión con Meta / WhatsApp">
        <P>
          Si conectás tu cuenta de Meta/WhatsApp, usamos las APIs oficiales de Meta (WhatsApp Cloud API y
          Meta Ads) para recibir y enviar mensajes y, cuando corresponda, medir tus campañas. Para eso podemos
          tratar identificadores de tu cuenta de WhatsApp Business y tokens de acceso provistos por Meta. Esos
          tokens se almacenan cifrados y se usan únicamente para operar la integración que autorizaste. El uso
          de esas APIs está sujeto también a las políticas de Meta.
        </P>
      </Section>

      <Section title="4. Uso de inteligencia artificial">
        <P>
          Para asistir las respuestas del bot y las recomendaciones internas usamos modelos de IA de terceros
          (actualmente Anthropic «Claude»). Le enviamos un contexto acotado y sanitizado —por ejemplo, el
          mensaje del cliente y datos públicos del catálogo— y evitamos enviar información sensible o privada
          que no sea necesaria. Las respuestas generadas por IA son automáticas y pueden contener errores; no
          reemplazan el criterio de la empresa.
        </P>
      </Section>

      <Section title="5. Pagos">
        <P>
          Hoy la activación de planes es <strong>manual</strong>: se coordina por WhatsApp y el pago se
          gestiona por fuera de la plataforma (transferencia u otros medios). No procesamos ni almacenamos
          datos de tarjetas en la plataforma. Si en el futuro habilitamos pagos en línea, lo informaremos y
          actualizaremos esta política.
        </P>
      </Section>

      <Section title="6. Dónde se almacenan los datos">
        <P>
          Los datos se alojan en la infraestructura de Firebase / Google Cloud (autenticación, base de datos y
          almacenamiento). Esos proveedores actúan como prestadores de servicios y pueden almacenar los datos
          en sus centros de datos.
        </P>
      </Section>

      <Section title="7. Con quién compartimos datos">
        <P>No vendemos tus datos. Los compartimos solo con proveedores que nos ayudan a prestar el servicio:</P>
        <UL
          items={[
            'Meta / WhatsApp, para la mensajería y la medición de anuncios que autorizaste.',
            'Anthropic, para generar respuestas asistidas por IA con el contexto acotado descrito arriba.',
            'Firebase / Google Cloud, para hosting, base de datos y almacenamiento.',
            'Cuando lo exija una obligación legal o una autoridad competente.',
          ]}
        />
      </Section>

      <Section title="8. Conservación y eliminación de datos">
        <P>
          Conservamos los datos mientras la cuenta esté activa y durante el tiempo necesario para los fines
          descritos. Podés solicitar la eliminación de los datos de tu empresa siguiendo el procedimiento de
          la página de{' '}
          <Link href="/data-deletion" className="font-medium text-mint-700 hover:text-mint-800">
            eliminación de datos
          </Link>
          . Algunos datos pueden conservarse por un período adicional cuando una obligación legal lo requiera.
        </P>
      </Section>

      <Section title="9. Seguridad">
        <P>
          Tomamos medidas razonables para proteger los datos (por ejemplo, control de acceso por roles,
          aislamiento por empresa y cifrado de los tokens de integración). Ningún sistema es completamente
          infalible, por lo que no podemos garantizar seguridad absoluta.
        </P>
      </Section>

      <Section title="10. Cambios a esta política">
        <P>
          Podemos actualizar esta política a medida que el producto evoluciona. Publicaremos la versión vigente
          en esta página con su fecha de actualización.
        </P>
      </Section>
    </LegalPage>
  );
}
