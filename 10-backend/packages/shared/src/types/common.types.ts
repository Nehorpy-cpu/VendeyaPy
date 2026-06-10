/**
 * Tipos base reutilizados por varias entidades.
 *
 * NOTA sobre `Timestamp`: en el cliente (Firestore Web SDK) se usa
 * `firebase/firestore`. En Cloud Functions (Admin SDK) se usa
 * `firebase-admin/firestore`. Acá usamos un tipo genérico que ambos satisfacen.
 */

export type Timestamp = {
  toDate(): Date;
  toMillis(): number;
  seconds: number;
  nanoseconds: number;
};

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface Address {
  street: string;
  houseNumber: string;
  city: string;
  neighborhood: string;
  reference: string;
  coordinates: Coordinates | null;
}
