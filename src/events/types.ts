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
  PromptRequestedEventSchema,
  PromptRespondedEventSchema,
  InterjectionReceivedEventSchema,
  TurnCancelledEventSchema,
  NodeFinalizedEventSchema,
  ActiveLeafChangedEventSchema,
  ConversationTitleUpdatedEventSchema,
  ErrorEventSchema,
} from '../schemas/events.js';

import { randomUUID } from 'node:crypto';
export function newEventId(): string {
  return randomUUID();
}
