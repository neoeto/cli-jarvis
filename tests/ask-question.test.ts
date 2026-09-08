import { describe, expect, it } from "vitest";
import { AskQuestionTool } from "../src/tools/builtins/ask-question.js";

describe("ask_question Tool", () => {
  it("accepts bounded single and multiple-choice question definitions", () => {
    const tool = new AskQuestionTool();
    expect(tool.parse({ question: "Pick deployment targets", options: [{ label: "staging" }, { label: "production", description: "requires review" }], multiple: true })).toMatchObject({
      question: "Pick deployment targets",
      multiple: true
    });
  });

  it("rejects duplicate option labels and unbounded option lists", () => {
    const tool = new AskQuestionTool();
    expect(() => tool.parse({ question: "Pick", options: [{ label: "same" }, { label: "SAME" }] })).toThrow(/unique/i);
    expect(() => tool.parse({ question: "Pick", options: Array.from({ length: 9 }, (_, index) => ({ label: String(index) })) })).toThrow();
  });
});
