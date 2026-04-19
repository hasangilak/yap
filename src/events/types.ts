export type { BusEvent, BusEventKind } from '../schemas/events.js';
export {
  BusEventSchema,
  NodeCreatedEventSchema,
  StatusUpdateEventSchema,
  ContentDeltaEventSchema,
  ReasoningDeltaEventSchema,
  ReasoningStepEndEventSchema,
  ToolCallProposedEventSchema,
  ToolCallStartedEventSchema,
  ToolCallEndedEventSchema,
  NodeFinalizedEventSchema,
  ActiveLeafChangedEventSchema,
  ErrorEventSchema,
} from '../schemas/events.js';

import { randomUUID } from 'node:crypto';
export function newEventId(): string {
  return randomUUID();
}
