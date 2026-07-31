/**
 * WHATSAPP-MEDIA-SAFE-FOUNDATION-1 (ADR-0016) — SHA-256 puro y síncrono.
 * ======================================================================
 * POR QUÉ una implementación propia y no `node:crypto` ni WebCrypto:
 *  - `@vpw/shared` se importa TAMBIÉN desde el panel (Next.js). Un `import 'node:crypto'` en
 *    el barrel del paquete rompe el bundle del cliente.
 *  - WebCrypto (`crypto.subtle.digest`) es ASÍNCRONO: la derivación del `attachmentId` tiene
 *    que poder usarse dentro de una transacción y de funciones puras testeables sin await.
 *  - El programa prohíbe dependencias nuevas.
 * Es un hash de IDENTIDAD/opacidad (derivar ids determinísticos), NO de autenticación: no hay
 * HMAC ni secretos acá. El checksum de los bytes descargados lo calcula el lado servidor con
 * `node:crypto` (streaming), que es su lugar natural.
 *
 * La corrección se verifica en `sha256.test.ts` contra vectores conocidos y contra
 * `node:crypto` (import SOLO de test, jamás del bundle).
 */

/** Constantes K de FIPS 180-4 (raíces cúbicas de los primeros 64 primos). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Estado inicial H0 de FIPS 180-4 (raíces cuadradas de los primeros 8 primos). */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * Codificación UTF-8 a mano en vez de `TextEncoder`: el `lib` del tsconfig es ES2022 SIN DOM,
 * así que el global no está tipado en todos los consumidores. Los surrogates sueltos se mapean
 * a U+FFFD, igual que haría `TextEncoder`, para que el hash de un string inválido siga siendo
 * determinístico.
 */
export function utf8Bytes(value: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let cp = value.codePointAt(i) ?? 0xfffd;
    if (cp > 0xffff) i += 1; // el par suplente ocupa dos unidades de código
    else if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // surrogate suelto
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

const HEX = '0123456789abcdef';

/** SHA-256 en hexadecimal minúscula (64 caracteres). Determinístico y sin estado global. */
export function sha256Hex(input: string | Uint8Array): string {
  const msg = typeof input === 'string' ? utf8Bytes(input) : input;
  const bitLen = msg.length * 8;

  // Padding: 0x80, ceros hasta dejar 8 bytes libres, y la longitud en bits big-endian de 64 bits.
  const paddedLen = ((msg.length + 9 + 63) >>> 6) << 6;
  const block = new Uint8Array(paddedLen);
  block.set(msg, 0);
  block[msg.length] = 0x80;
  const hiBits = Math.floor(bitLen / 0x100000000);
  const loBits = bitLen >>> 0;
  block[paddedLen - 8] = (hiBits >>> 24) & 0xff;
  block[paddedLen - 7] = (hiBits >>> 16) & 0xff;
  block[paddedLen - 6] = (hiBits >>> 8) & 0xff;
  block[paddedLen - 5] = hiBits & 0xff;
  block[paddedLen - 4] = (loBits >>> 24) & 0xff;
  block[paddedLen - 3] = (loBits >>> 16) & 0xff;
  block[paddedLen - 2] = (loBits >>> 8) & 0xff;
  block[paddedLen - 1] = loBits & 0xff;

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      const i = offset + t * 4;
      w[t] =
        (((block[i] as number) << 24) |
          ((block[i + 1] as number) << 16) |
          ((block[i + 2] as number) << 8) |
          (block[i + 3] as number)) >>>
        0;
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }

    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;

    for (let t = 0; t < 64; t += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + (K[t] as number) + (w[t] as number)) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i += 1) {
    const word = h[i] as number;
    for (let shift = 28; shift >= 0; shift -= 4) {
      hex += HEX[(word >>> shift) & 0xf];
    }
  }
  return hex;
}
