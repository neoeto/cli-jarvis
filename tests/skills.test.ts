import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkills, fingerprintSkillDirectory, readSkillResource } from "../src/skills/catalog.js";
import { ReadSkillTool } from "../src/tools/builtins/read-skill.js";
import type { ToolContext } from "../src/tools/types.js";
import { createSystemPrompt } from "../src/agent/system-prompt.js";

const created: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cj-skills-test-"));
  created.push(directory);
  return directory;
}

async function writeSkill(root: string, directory: string, name: string, description = "Useful test guidance", body = "Follow the test workflow."): Promise<string> {
  const target = path.join(root, directory);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
  return target;
}

function context(catalog: Awaited<ReturnType<typeof discoverSkills>>): ToolContext {
  return { workspaceRoot: process.cwd(), signal: new AbortController().signal, language: "en", skillCatalog: catalog };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agent Skills", () => {
  it("merges trusted workspace Skills over user Skills without exposing untrusted workspace Skills", async () => {
    const root = await temporaryDirectory();
    const user = path.join(root, "user");
    const workspace = path.join(root, "workspace", ".cj", "skills");
    await writeSkill(user, "review", "review", "User workflow", "user instructions");
    await writeSkill(workspace, "review", "review", "Workspace workflow", "workspace instructions");
    await writeSkill(workspace, "private", "private", "Workspace-only workflow");

    const untrusted = await discoverSkills({ userDirectory: user, workspaceDirectory: workspace, trustedWorkspaceDirectories: [] });
    expect(untrusted.skills).toEqual([expect.objectContaining({ name: "review", source: "user", description: "User workflow" })]);
    expect(untrusted.diagnostics).toContainEqual(expect.objectContaining({ source: "workspace", ok: false }));

    const fingerprint = await fingerprintSkillDirectory(workspace);
    const trusted = await discoverSkills({ userDirectory: user, workspaceDirectory: workspace, trustedWorkspaceDirectories: [{ directory: workspace, fingerprint }] });
    expect(trusted.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "review", source: "workspace", description: "Workspace workflow" }),
      expect.objectContaining({ name: "private", source: "workspace" })
    ]));
  });

  it("invalidates workspace trust when any package resource changes", async () => {
    const root = await temporaryDirectory();
    const user = path.join(root, "user");
    const workspace = path.join(root, "workspace", ".cj", "skills");
    const skill = await writeSkill(workspace, "deploy", "deploy");
    await mkdir(path.join(skill, "references"));
    await writeFile(path.join(skill, "references", "guide.md"), "first version");
    const fingerprint = await fingerprintSkillDirectory(workspace);
    await writeFile(path.join(skill, "references", "guide.md"), "changed version");
    const catalog = await discoverSkills({ userDirectory: user, workspaceDirectory: workspace, trustedWorkspaceDirectories: [{ directory: workspace, fingerprint }] });
    expect(catalog.skills).toEqual([]);
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ source: "workspace", ok: false, message: expect.stringContaining("changed") }));
  });

  it("reads only package-relative text resources and redacts secrets", async () => {
    const root = await temporaryDirectory();
    const user = path.join(root, "user");
    const skill = await writeSkill(user, "release", "release", "Release checklist", "secret: abcdefghijkl\nUse the checklist.");
    await mkdir(path.join(skill, "references"));
    await writeFile(path.join(skill, "references", "checks.md"), "token: abcdefghijkl\nship it");
    await writeFile(path.join(skill, "binary.bin"), Buffer.from([1, 0, 2]));
    const catalog = await discoverSkills({ userDirectory: user, workspaceDirectory: path.join(root, "workspace", ".cj", "skills"), trustedWorkspaceDirectories: [] });
    const tool = new ReadSkillTool();
    const action = await tool.prepare(tool.parse({ name: "release", path: "references/checks.md" }), context(catalog));
    const result = await tool.execute(action, context(catalog));
    expect(result.data?.content).toContain("[REDACTED]");
    await expect(tool.prepare(tool.parse({ name: "release", path: "../outside.md" }), context(catalog))).rejects.toMatchObject({ code: "TOOL_INPUT_INVALID" });
    await expect(tool.prepare(tool.parse({ name: "release", path: "binary.bin" }), context(catalog))).rejects.toMatchObject({ code: "TOOL_FAILED" });
  });

  it("fails closed if a skill changes after catalog discovery", async () => {
    const root = await temporaryDirectory();
    const user = path.join(root, "user");
    const skillDirectory = await writeSkill(user, "changes", "changes");
    const catalog = await discoverSkills({ userDirectory: user, workspaceDirectory: path.join(root, "workspace", ".cj", "skills"), trustedWorkspaceDirectories: [] });
    await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: changes\ndescription: Useful test guidance\n---\nchanged\n");
    await expect(readSkillResource(catalog.skills[0]!)).rejects.toMatchObject({ code: "TOOL_FAILED" });
  });

  it("does not put Skill bodies in the system prompt and rechecks an action before reading", async () => {
    const root = await temporaryDirectory();
    const user = path.join(root, "user");
    const skillDirectory = await writeSkill(user, "private_plan", "private_plan", "Private planning workflow", "DO NOT EXPOSE THIS BODY");
    const catalog = await discoverSkills({ userDirectory: user, workspaceDirectory: path.join(root, "workspace", ".cj", "skills"), trustedWorkspaceDirectories: [] });
    const prompt = createSystemPrompt(root, "en", catalog.skills);
    expect(prompt).toContain("private_plan");
    expect(prompt).not.toContain("DO NOT EXPOSE THIS BODY");
    const tool = new ReadSkillTool();
    const action = await tool.prepare(tool.parse({ name: "private_plan" }), context(catalog));
    await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: private_plan\ndescription: Private planning workflow\n---\nchanged\n");
    await expect(tool.execute(action, context(catalog))).rejects.toMatchObject({ code: "TOOL_FAILED" });
  });
});
