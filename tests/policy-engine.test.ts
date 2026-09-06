import { describe, expect, it, vi } from "vitest";
import { PolicyEngine } from "../src/policy/engine.js";
import type { PreparedAction } from "../src/tools/types.js";

function action(overrides: Partial<PreparedAction> = {}): PreparedAction {
  return {
    id: "12345678-abcd",
    toolName: "write_file",
    riskLevel: "low",
    summary: "Write a file",
    targets: ["/workspace/file.txt"],
    effects: ["write"],
    reversible: true,
    payload: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  };
}

describe("PolicyEngine", () => {
  it("allows low and medium risk actions without confirmation", async () => {
    const policy = new PolicyEngine();
    const confirm = vi.fn(async () => true);
    for (const riskLevel of ["low", "medium"] as const) {
      const decision = policy.evaluate(action({ riskLevel }));
      await policy.authorize(decision, {
        interactive: true,
        signal: new AbortController().signal,
        confirm
      });
      expect(decision.confirmation).toBeUndefined();
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it("requires the confirmation handler for a high-risk action", async () => {
    const policy = new PolicyEngine();
    const confirm = vi.fn(async () => true);
    const decision = policy.evaluate(action({ riskLevel: "high", reversible: false }));
    await policy.authorize(decision, {
      interactive: true,
      signal: new AbortController().signal,
      confirm
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        reversible: false
      }),
      expect.any(AbortSignal)
    );
  });

  it("fails closed in a non-interactive environment", async () => {
    const policy = new PolicyEngine();
    const decision = policy.evaluate(action({ riskLevel: "high" }));
    await expect(
      policy.authorize(decision, {
        interactive: false,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });

  it("treats run_command as high-risk regardless of its declaration", () => {
    const decision = new PolicyEngine().evaluate(
      action({ toolName: "run_command", riskLevel: "low", effects: ["process"] })
    );
    expect(decision.effectiveRisk).toBe("high");
    expect(decision.confirmation).toBeDefined();
  });

  it("stops when the user rejects an action", async () => {
    const policy = new PolicyEngine();
    const decision = policy.evaluate(action({ riskLevel: "high" }));
    await expect(
      policy.authorize(decision, {
        interactive: true,
        signal: new AbortController().signal,
        confirm: async () => false
      })
    ).rejects.toMatchObject({ code: "CONFIRMATION_REJECTED" });
  });
});
