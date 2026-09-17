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
  // Full exchanges are persisted only in the owner-only audit log for HTML
  // export. Streaming them to stdout would leak model context to pipelines.
  if (event.type === "model_interaction") return;
  process.stdout.write(`${JSON.stringify({ version: 1, ...publicEvent(event) })}\n`);
};
