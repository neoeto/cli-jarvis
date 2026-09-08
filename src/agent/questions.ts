/** A host-rendered clarification request initiated by the model. */
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionRequest {
  question: string;
  options: QuestionOption[];
  multiple: boolean;
}

/** The answer returned to the model as the result of ask_question. */
export interface QuestionAnswer {
  selected: string[];
  custom?: string;
  /** A compact, model-ready representation of the user's full answer. */
  answer: string;
}

export type QuestionHandler = (request: QuestionRequest, signal: AbortSignal) => Promise<QuestionAnswer>;
