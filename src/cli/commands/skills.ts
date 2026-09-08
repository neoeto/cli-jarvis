import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import type { ConfigStore } from "../../config/store.js";
import { discoverSkills, fingerprintSkillDirectory, findSkill, readSkillResource } from "../../skills/catalog.js";
import { CjError } from "../../shared/errors.js";

async function workspaceSkillsDirectory(): Promise<string> {
  const workspace = await realpath(process.cwd());
  return path.join(workspace, ".cj", "skills");
}

async function catalog(store: ConfigStore) {
  const config = await store.loadConfig();
  return discoverSkills({
    userDirectory: store.paths.skillsDir,
    workspaceDirectory: await workspaceSkillsDirectory(),
    trustedWorkspaceDirectories: config.skills.trustedWorkspaceDirectories
  });
}

/** Add management commands for local Agent Skills. */
export function addSkillsCommand(program: Command, store: ConfigStore): void {
  const command = program.command("skills")
    .description("Inspect and trust local Agent Skills")
    .addHelpText("after", `
Skills use the standard SKILL.md frontmatter format. User Skills live under the
configuration directory; workspace Skills live in .cj/skills and must be trusted
explicitly. Skills only provide instructions and text resources; they cannot run
scripts automatically or bypass CJ's Tool confirmation and authorization rules.

Examples:
  cj skills list
  cj skills trust
  cj skills show my_skill
  cj skills untrust
`);

  command.command("list").description("List available, trusted Skills and their source").action(async () => {
    for (const skill of (await catalog(store)).skills) {
      process.stdout.write(`${skill.name}\t${skill.source}\t${skill.description}\n`);
    }
  });

  command.command("show").argument("<name>").description("Show a Skill's metadata and redacted SKILL.md").action(async (name: string) => {
    const skill = findSkill(await catalog(store), name);
    const text = await readSkillResource(skill);
    process.stdout.write(`${JSON.stringify({ name: skill.name, description: skill.description, source: skill.source, path: text.resource, truncated: text.truncated, redactions: text.redactions }, null, 2)}\n`);
    process.stdout.write(`${text.content}${text.content.endsWith("\n") ? "" : "\n"}`);
  });

  command.command("doctor").description("Validate user and workspace Skill directories and trust state").action(async () => {
    const result = await catalog(store);
    if (result.diagnostics.length === 0) {
      process.stdout.write("No Skill candidates found.\n");
      return;
    }
    for (const diagnostic of result.diagnostics) {
      process.stdout.write(`${diagnostic.ok ? "✓" : "✗"}\t${diagnostic.source}\t${diagnostic.name ?? diagnostic.directory}\t${diagnostic.message}\n`);
    }
    if (result.diagnostics.some((diagnostic) => !diagnostic.ok)) process.exitCode = 1;
  });

  command.command("trust").description("Trust the current workspace's .cj/skills content until it changes").action(async () => {
    const directory = await workspaceSkillsDirectory();
    let fingerprint: string;
    try {
      fingerprint = await fingerprintSkillDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CjError("CONFIG_INVALID", `No workspace Skill directory found: ${directory}`);
      throw error;
    }
    const config = await store.loadConfig();
    await store.saveConfig({
      ...config,
      skills: {
        trustedWorkspaceDirectories: [
          ...config.skills.trustedWorkspaceDirectories.filter((item) => item.directory !== directory),
          { directory, fingerprint }
        ]
      }
    });
    process.stdout.write(`Trusted workspace Skill directory: ${directory}\n`);
  });

  command.command("untrust").description("Remove trust for the current workspace's .cj/skills directory").action(async () => {
    const directory = await workspaceSkillsDirectory();
    const config = await store.loadConfig();
    const trustedWorkspaceDirectories = config.skills.trustedWorkspaceDirectories.filter((item) => item.directory !== directory);
    if (trustedWorkspaceDirectories.length === config.skills.trustedWorkspaceDirectories.length) {
      process.stdout.write(`Workspace Skill directory was not trusted: ${directory}\n`);
      return;
    }
    await store.saveConfig({ ...config, skills: { trustedWorkspaceDirectories } });
    process.stdout.write(`Removed trust for workspace Skill directory: ${directory}\n`);
  });
}
