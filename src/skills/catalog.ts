import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { CjError } from "../shared/errors.js";
import { redactSecrets } from "../policy/sensitive-data.js";

const skillName = /^[a-z][a-z0-9_-]{1,63}$/;
const maximumSkillFileBytes = 256 * 1024;

export type SkillSource = "user" | "workspace";

export interface SkillDescriptor {
  name: string;
  description: string;
  directory: string;
  source: SkillSource;
  fingerprint: string;
}

export interface SkillCatalog {
  skills: SkillDescriptor[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillDiagnostic {
  directory: string;
  source: SkillSource;
  name?: string;
  ok: boolean;
  message: string;
}

export interface DiscoverSkillsOptions {
  userDirectory: string;
  workspaceDirectory: string;
  trustedWorkspaceDirectories: readonly { directory: string; fingerprint: string }[];
}

interface Frontmatter {
  name: string;
  description: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function relativeFilePath(value: string): string {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]+/).some((part) => part === ".." || !part)) {
    throw new CjError("TOOL_INPUT_INVALID", "Skill resource path must be a non-empty package-relative path");
  }
  return value.split(/[\\/]+/).join(path.sep);
}

async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(current, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) throw new CjError("CONFIG_INVALID", `Skill packages cannot contain symbolic links: ${entryPath}`);
      if (entryStat.isDirectory()) await visit(entryPath);
      else if (entryStat.isFile()) files.push(entryPath);
      else throw new CjError("CONFIG_INVALID", `Skill packages can contain only regular files and directories: ${entryPath}`);
    }
  };
  await visit(directory);
  return files;
}

async function hashFile(hash: ReturnType<typeof createHash>, file: string, relative: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    hash.update(relative);
    hash.update("\0");
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    hash.update("\0");
  } finally {
    await handle.close();
  }
}

/** Hash every file and path in a Skill root so any package edit invalidates trust. */
export async function fingerprintSkillDirectory(directory: string): Promise<string> {
  const rootStat = await lstat(directory);
  if (rootStat.isSymbolicLink()) throw new CjError("CONFIG_INVALID", `Skill directories cannot be symbolic links: ${directory}`);
  const resolved = await realpath(directory);
  if (!(await stat(resolved)).isDirectory()) throw new CjError("CONFIG_INVALID", `Skill directory is not a directory: ${directory}`);
  const hash = createHash("sha256");
  for (const file of await regularFiles(resolved)) await hashFile(hash, file, path.relative(resolved, file));
  return hash.digest("hex");
}

export async function fingerprintSkillPackage(directory: string): Promise<string> {
  return fingerprintSkillDirectory(directory);
}

async function boundedText(file: string, maxBytes: number): Promise<{ content: string; truncated: boolean }> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new CjError("TOOL_FAILED", `Skill resource is not a regular file: ${file}`);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    if (data.includes(0)) throw new CjError("TOOL_FAILED", `Skill resource is not UTF-8 text: ${path.basename(file)}`);
    return { content: data.toString("utf8"), truncated: bytesRead > maxBytes };
  } finally {
    await handle.close();
  }
}

function parseFrontmatter(content: string, file: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new CjError("CONFIG_INVALID", `Skill must start with YAML frontmatter: ${file}`);
  const document = parseDocument(match[1] ?? "");
  if (document.errors.length) throw new CjError("CONFIG_INVALID", `Invalid YAML frontmatter in ${file}: ${document.errors[0]?.message ?? "unknown error"}`);
  const value = document.toJSON();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CjError("CONFIG_INVALID", `Skill frontmatter must be a mapping: ${file}`);
  const name = (value as Record<string, unknown>).name;
  const description = (value as Record<string, unknown>).description;
  if (typeof name !== "string" || !skillName.test(name)) throw new CjError("CONFIG_INVALID", `Invalid skill name in ${file}`);
  if (typeof description !== "string" || !description.trim() || description.length > 2_000) {
    throw new CjError("CONFIG_INVALID", `Invalid skill description in ${file}`);
  }
  return { name, description: description.trim() };
}

async function discoverSource(
  root: string,
  source: SkillSource,
  trustedFingerprint: string | undefined
): Promise<{ skills: SkillDescriptor[]; diagnostics: SkillDiagnostic[]; rootFingerprint?: string }> {
  let resolvedRoot: string;
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new CjError("CONFIG_INVALID", `Skill directories cannot be symbolic links: ${root}`);
    resolvedRoot = await realpath(root);
    if (!(await stat(resolvedRoot)).isDirectory()) throw new CjError("CONFIG_INVALID", `Skill root is not a directory: ${root}`);
  } catch (error) {
    if (isMissing(error)) return { skills: [], diagnostics: [] };
    return { skills: [], diagnostics: [{ directory: root, source, ok: false, message: error instanceof Error ? error.message : String(error) }] };
  }

  let rootFingerprint: string;
  try {
    rootFingerprint = await fingerprintSkillDirectory(resolvedRoot);
  } catch (error) {
    return { skills: [], diagnostics: [{ directory: resolvedRoot, source, ok: false, message: error instanceof Error ? error.message : String(error) }] };
  }
  if (source === "workspace" && trustedFingerprint !== rootFingerprint) {
    return {
      skills: [],
      diagnostics: [{ directory: resolvedRoot, source, ok: false, message: trustedFingerprint ? "Workspace Skill directory changed; run cj skills trust again" : "Workspace Skill directory is not trusted; run cj skills trust" }],
      rootFingerprint
    };
  }

  const diagnostics: SkillDiagnostic[] = [];
  const skills: SkillDescriptor[] = [];
  const names = new Set<string>();
  for (const entry of (await readdir(resolvedRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      diagnostics.push({ directory: path.join(resolvedRoot, entry.name), source, ok: false, message: "Skill entries must be directories" });
      continue;
    }
    const directory = path.join(resolvedRoot, entry.name);
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new CjError("CONFIG_INVALID", "Skill directories cannot be symbolic links");
      const skillFile = path.join(directory, "SKILL.md");
      const text = await boundedText(skillFile, maximumSkillFileBytes);
      if (text.truncated) throw new CjError("CONFIG_INVALID", `SKILL.md exceeds ${maximumSkillFileBytes} bytes`);
      const frontmatter = parseFrontmatter(text.content, skillFile);
      if (names.has(frontmatter.name)) {
        const earlier = diagnostics.find((diagnostic) => diagnostic.name === frontmatter.name && diagnostic.ok);
        if (earlier) {
          earlier.ok = false;
          earlier.message = `Duplicate skill name in ${source} Skill directory: ${frontmatter.name}`;
        }
        const index = skills.findIndex((skill) => skill.name === frontmatter.name);
        if (index >= 0) skills.splice(index, 1);
        throw new CjError("CONFIG_INVALID", `Duplicate skill name in ${source} Skill directory: ${frontmatter.name}`);
      }
      names.add(frontmatter.name);
      const fingerprint = await fingerprintSkillPackage(directory);
      skills.push({ name: frontmatter.name, description: redactSecrets(frontmatter.description).value, directory, source, fingerprint });
      diagnostics.push({ directory, source, name: frontmatter.name, ok: true, message: "Available" });
    } catch (error) {
      diagnostics.push({ directory, source, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { skills, diagnostics, rootFingerprint };
}

export async function discoverSkills(options: DiscoverSkillsOptions): Promise<SkillCatalog> {
  const user = await discoverSource(options.userDirectory, "user", undefined);
  const expectedWorkspace = path.resolve(options.workspaceDirectory);
  const trusted = options.trustedWorkspaceDirectories.find((item) => path.resolve(item.directory) === expectedWorkspace);
  const workspace = await discoverSource(options.workspaceDirectory, "workspace", trusted?.fingerprint);
  const merged = new Map(user.skills.map((skill) => [skill.name, skill]));
  for (const skill of workspace.skills) merged.set(skill.name, skill);
  return { skills: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)), diagnostics: [...user.diagnostics, ...workspace.diagnostics] };
}

export function findSkill(catalog: SkillCatalog, name: string): SkillDescriptor {
  const skill = catalog.skills.find((candidate) => candidate.name === name);
  if (!skill) throw new CjError("TOOL_INPUT_INVALID", `Unknown or unavailable Skill: ${name}`);
  return skill;
}

export async function readSkillResource(
  skill: SkillDescriptor,
  resource = "SKILL.md",
  maxBytes = maximumSkillFileBytes
): Promise<{ content: string; truncated: boolean; redactions: number; resource: string }> {
  const relative = relativeFilePath(resource);
  const target = path.resolve(skill.directory, relative);
  if (target !== skill.directory && !target.startsWith(`${skill.directory}${path.sep}`)) {
    throw new CjError("TOOL_INPUT_INVALID", "Skill resource path escapes its package");
  }
  const currentFingerprint = await fingerprintSkillPackage(skill.directory);
  if (currentFingerprint !== skill.fingerprint) throw new CjError("TOOL_FAILED", `Skill changed since discovery: ${skill.name}`);
  const text = await boundedText(target, Math.min(maxBytes, maximumSkillFileBytes));
  if (await fingerprintSkillPackage(skill.directory) !== skill.fingerprint) {
    throw new CjError("TOOL_FAILED", `Skill changed while being read: ${skill.name}`);
  }
  const redacted = redactSecrets(text.content);
  return { content: redacted.value, truncated: text.truncated, redactions: redacted.redactions, resource: relative.split(path.sep).join("/") };
}
