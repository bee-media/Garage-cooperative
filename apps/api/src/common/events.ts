import { EventEmitter } from 'node:events';

/** Лёгкая шина событий внутри процесса (без зависимостей между модулями) */
export const appEvents = new EventEmitter();

export interface PaymentCreatedEvent {
  paymentId: number;
  garageId: number;
  actorId: number;
}
