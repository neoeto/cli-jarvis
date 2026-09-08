import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import { getAppPaths } from "../src/config/paths.js";

const execFileAsync = promisify(execFile);
const created: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nUse this workflow.\n`);
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("skills commands", () => {
  it("lists user Skills and trusts, invalidates, then untrusts workspace Skills", async () => {
    const workspace = await temporaryDirectory("cj-skills-workspace-");
    const configDirectory = await temporaryDirectory("cj-skills-config-");
    await writeSkill(path.join(configDirectory, "skills"), "user_flow", "User workflow");
    const workspaceSkills = path.join(workspace, ".cj", "skills");
    await writeSkill(workspaceSkills, "workspace_flow", "Workspace workflow");
    const entry = path.resolve("src/cli/index.ts");
    const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, CJ_CONFIG_DIR: configDirectory, NO_COLOR: "1" };
    const run = async (...args: string[]) => execFileAsync(process.execPath, ["--import", tsxImport, entry, "skills", ...args], { cwd: workspace, env });

    expect((await run("list")).stdout).toContain("user_flow\tuser");
    expect((await run("trust")).stdout).toContain("Trusted workspace Skill directory");
    expect((await run("list")).stdout).toContain("workspace_flow\tworkspace");
    const saved = await new ConfigStore(getAppPaths({ CJ_CONFIG_DIR: configDirectory })).loadConfig();
    expect(saved.skills.trustedWorkspaceDirectories).toHaveLength(1);

    await writeFile(path.join(workspaceSkills, "workspace_flow", "reference.md"), "changed");
    await expect(run("doctor")).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("changed") });
    expect((await run("untrust")).stdout).toContain("Removed trust");
    expect((await run("list")).stdout).not.toContain("workspace_flow");
  }, 15_000);
});
