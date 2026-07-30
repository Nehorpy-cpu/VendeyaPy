/**
 * catalogOwnership.test.ts — Helpers puros del modelo de propiedad (ADR-0015).
 *
 * El grupo importante es el SANEADO: una URL firmada, su query string o un token JAMÁS pueden
 * llegar a la pantalla, aunque el backend los mande adentro del nombre de la fuente. Sin el
 * saneador estos casos pintarían el enlace del feed completo en el panel.
 */
import { describe, it, expect } from 'vitest';
import {
  ESTADO_META_INFO,
  ESTADO_SIN_VERIFICAR,
  describirHorario,
  esCampoCritico,
  esCampoPublico,
  etiquetaCampo,
  etiquetaMotivo,
  etiquetaTipoFuente,
  hostDe,
  sanitizarTextoPublico,
  valorMostrable,
} from './catalogOwnership';

describe('sanitizarTextoPublico — nunca deja pasar un secreto', () => {
  it('saca la URL del feed con su query string y su token', () => {
    const sucio = 'Feed diario https://arfagi.com/feed.csv?access_token=EAAG9ZC1secreto&sig=abc';
    const limpio = sanitizarTextoPublico(sucio);
    expect(limpio).toBe('Feed diario');
    expect(limpio).not.toContain('http');
    expect(limpio).not.toContain('access_token');
    expect(limpio).not.toContain('EAAG9ZC1secreto');
    expect(limpio).not.toContain('?');
  });

  it('saca pares clave=valor sensibles sueltos y cadenas opacas largas', () => {
    expect(sanitizarTextoPublico('Catálogo token=abc123 listo')).toBe('Catálogo listo');
    expect(sanitizarTextoPublico('Feed EAAGm0PX4ZCpsBOZBk1secretosecretosecreto ok')).toBe('Feed ok');
  });

  it('saca URLs sin esquema (//host) y protocolos raros', () => {
    expect(sanitizarTextoPublico('Fuente //cdn.arfagi.com/x.csv')).toBe('Fuente');
    expect(sanitizarTextoPublico('Fuente ftp://user:pass@host/x')).toBe('Fuente');
  });

  it('respeta un nombre humano normal y aplasta saltos de línea', () => {
    expect(sanitizarTextoPublico('Catálogo Arfagi — sitio web')).toBe('Catálogo Arfagi — sitio web');
    expect(sanitizarTextoPublico('Feed\n\tdiario')).toBe('Feed diario');
  });

  it('lo que no es texto o queda vacío devuelve cadena vacía (el llamador pone su fallback)', () => {
    expect(sanitizarTextoPublico(undefined)).toBe('');
    expect(sanitizarTextoPublico({ url: 'https://x.com' })).toBe('');
    expect(sanitizarTextoPublico('https://arfagi.com/feed.csv?token=1')).toBe('');
  });

  it('trunca lo demasiado largo con puntos suspensivos', () => {
    const largo = sanitizarTextoPublico('Catálogo diario de la tienda '.repeat(10), 20);
    expect(largo.length).toBeLessThanOrEqual(20);
    expect(largo.endsWith('…')).toBe(true);
  });
});

describe('hostDe — solo el host, jamás la ruta ni la query', () => {
  it('devuelve el host sin esquema, sin credenciales, sin ruta y sin query', () => {
    expect(hostDe('https://cdn.arfagi.com/img/odyssey.jpg?token=secreto')).toBe('cdn.arfagi.com');
    expect(hostDe('https://user:pass@cdn.arfagi.com/x')).toBe('cdn.arfagi.com');
    expect(hostDe('//cdn.arfagi.com/x')).toBe('cdn.arfagi.com');
  });

  it('lo que no es un enlace devuelve vacío', () => {
    expect(hostDe('no soy un enlace')).toBe('');
    expect(hostDe(42)).toBe('');
  });
});

describe('describirHorario', () => {
  it('arma el horario legible desde hora/minuto/zona', () => {
    expect(describirHorario({ hour: 3, minute: 33, timezone: 'America/Asuncion' })).toBe(
      'todos los días a las 03:33 (America/Asuncion)',
    );
  });

  it('acepta el texto ya armado y lo sanea igual', () => {
    expect(describirHorario('todos los días 03:33 https://x.com/f.csv?t=1')).toBe('todos los días 03:33');
  });

  it('sin datos devuelve vacío', () => {
    expect(describirHorario(null)).toBe('');
    expect(describirHorario(7)).toBe('');
  });

  it('combina el horario suelto con su zona SIN inventar una frecuencia que nadie declaró', () => {
    // Forma de MetaCatalogDetectedSource: schedule '03:33' + timezone aparte.
    expect(describirHorario('03:33', 'America/Asuncion')).toBe('a las 03:33 (America/Asuncion)');
    // Y la zona también se sanea: nunca puede colarse un enlace por ese campo.
    expect(describirHorario('03:33', 'https://arfagi.com/f.csv?t=1')).toBe('a las 03:33');
  });
});

describe('estado contra lo publicado — solo el verde afirma que coincide', () => {
  it('`verified` es el ÚNICO mint; todo lo demás avisa en vez de afirmar', () => {
    expect(ESTADO_META_INFO.verified.tono).toBe('mint');
    for (const estado of ['drifted', 'drifted_external', 'remote_missing', 'unverifiable', 'stale', 'desconocido'] as const) {
      expect(ESTADO_META_INFO[estado].tono).not.toBe('mint');
    }
  });

  it('"vencida" y "sin verificar" son etiquetas DISTINTAS: una existió y caducó, la otra nunca ocurrió', () => {
    expect(ESTADO_META_INFO.stale.label).toBe('Verificación vencida');
    expect(ESTADO_META_INFO.desconocido.label).toBe('Sin verificar');
    expect(ESTADO_META_INFO.stale.label).not.toBe(ESTADO_META_INFO.desconocido.label);
  });

  it('el estado de "Meta aceptó el envío pero nadie leyó lo publicado" no es verde y lo explica', () => {
    expect(ESTADO_SIN_VERIFICAR.tono).not.toBe('mint');
    expect(ESTADO_SIN_VERIFICAR.label).toBe('Sin verificar');
    expect(ESTADO_SIN_VERIFICAR.ayuda).toMatch(/todavía no leímos el catálogo publicado/);
    // Y jamás afirma lo que afirmaba el badge viejo.
    expect(ESTADO_SIN_VERIFICAR.ayuda).not.toMatch(/quedó igual que acá/);
  });
});

describe('valorMostrable — comparar sin filtrar', () => {
  it('formatea el precio en guaraníes venga como número o como texto de Meta', () => {
    expect(valorMostrable('price', 250000)).toBe('₲ 250.000');
    expect(valorMostrable('price', '130000 PYG')).toBe('₲ 130.000');
  });

  it('traduce la disponibilidad de Meta', () => {
    expect(valorMostrable('availability', 'in stock')).toBe('con stock');
    expect(valorMostrable('availability', 'out of stock')).toBe('sin stock');
  });

  it('de una imagen o un enlace muestra SOLO el host (el enlace puede venir firmado)', () => {
    const v = valorMostrable('image', 'https://cdn.arfagi.com/a/b.jpg?token=secreto&sig=x');
    expect(v).toBe('enlace de cdn.arfagi.com');
    expect(v).not.toContain('token');
    expect(v).not.toContain('https');
  });

  it('vacío o ausente se muestra como raya, no como "undefined"', () => {
    expect(valorMostrable('title', null)).toBe('—');
    expect(valorMostrable('title', '')).toBe('—');
  });
});

describe('etiquetas', () => {
  it('traduce campos, motivos y tipos de fuente sin dejar códigos crudos a la vista', () => {
    expect(etiquetaCampo('price')).toBe('Precio');
    expect(etiquetaCampo('inventado')).toBe('inventado');
    expect(etiquetaMotivo('ownership_missing')).toMatch(/nadie declaró/);
    expect(etiquetaMotivo('motivo_nuevo_del_backend')).toMatch(/necesita revisión/);
    expect(etiquetaTipoFuente('meta_feed')).toMatch(/Archivo de catálogo/);
    expect(etiquetaTipoFuente('otra_cosa')).toMatch(/sin identificar/);
  });

  it('los campos que frenan una venta son plata y disponibilidad', () => {
    expect(esCampoCritico('price')).toBe(true);
    expect(esCampoCritico('availability')).toBe(true);
    expect(esCampoCritico('inventory')).toBe(true);
    expect(esCampoCritico('title')).toBe(false);
    expect(esCampoCritico('image')).toBe(false);
  });

  it('los datos internos NO son campos públicos (no se publican ni se delegan)', () => {
    expect(esCampoPublico('price')).toBe(true);
    expect(esCampoPublico('cost')).toBe(false);
    expect(esCampoPublico('productFinancials')).toBe(false);
    expect(esCampoPublico('aiFicha')).toBe(false);
  });
});
