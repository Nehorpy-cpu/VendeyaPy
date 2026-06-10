/**
 * Entregas y repartidores.
 * Ver ARCHITECTURE.md §4.7 y §4.8.
 */

import type { DeliveryStatus, DriverStatus } from '../enums.js';
import type { Address, Coordinates, Timestamp } from './common.types.js';

export interface DeliveryTimelineEvent {
  status: DeliveryStatus;
  timestamp: Timestamp;
  note: string;
  coordinates: Coordinates | null;
}

export interface Delivery {
  id: string;
  tenantId: string;
  orderId: string;
  customerId: string;
  status: DeliveryStatus;
  assignedDriverId: string | null;
  destination: Address;
  timeline: DeliveryTimelineEvent[];
  estimatedDeliveryAt: Timestamp | null;
  deliveredAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DriverLocation {
  coordinates: Coordinates;
  updatedAt: Timestamp;
}

export interface DriverStats {
  deliveriesToday: number;
  deliveriesTotal: number;
  successRate: number;
  rating: number;
}

export interface DeliveryPerson {
  id: string;
  tenantId: string;
  name: string;
  whatsappPhone: string;
  status: DriverStatus;
  isActive: boolean;
  area: string;
  currentLocation: DriverLocation | null;
  stats: DriverStats;
  activeDeliveryIds: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
