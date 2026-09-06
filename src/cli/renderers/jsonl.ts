import type { AgentEvent, EventSink } from "../../agent/events.js";

function publicEvent(event: AgentEvent): Record<string, unknown> {
  if (event.type === "confirmation_requested") {
    const { actionId: _actionId, ...request } = event.request;
    return { type: event.type, request };
  }
  if (event.type === "confirmation_resolved") {
    return { type: event.type, approved: event.approved };
  }
  return event;
}

export const jsonlRenderer: EventSink = (event: AgentEvent) => {
  process.stdout.write(`${JSON.stringify({ version: 1, ...publicEvent(event) })}\n`);
};
