import { realpath } from "node:fs/promises";
import path from "node:path";
import { CjError } from "../shared/errors.js";

export interface ResolvedPath {
  workspaceRoot: string;
  path: string;
  external: boolean;
}

export function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolveExistingPath(workspaceRoot: string, requested: string): Promise<ResolvedPath> {
  const realRoot = await realpath(workspaceRoot);
  const candidate = path.resolve(realRoot, requested);
  let target: string;
  try {
    target = await realpath(candidate);
  } catch (error) {
    throw new CjError("TOOL_INPUT_INVALID", `Path does not exist: ${requested}`, { cause: error });
  }
  return { workspaceRoot: realRoot, path: target, external: !isPathWithin(realRoot, target) };
}

export async function resolveDestinationPath(workspaceRoot: string, requested: string): Promise<ResolvedPath> {
  const realRoot = await realpath(workspaceRoot);
  const candidate = path.resolve(realRoot, requested);
  const parent = path.dirname(candidate);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch (error) {
    throw new CjError("TOOL_INPUT_INVALID", `Parent directory does not exist: ${requested}`, { cause: error });
  }
  const target = path.join(realParent, path.basename(candidate));
  return { workspaceRoot: realRoot, path: target, external: !isPathWithin(realRoot, target) };
}

export async function resolveAuthorizedExistingPath(workspaceRoot: string, requested: string): Promise<string> {
  const resolved = await resolveExistingPath(workspaceRoot, requested);
  if (resolved.external) {
    throw new CjError("PATH_NOT_AUTHORIZED", `Path is outside the current workspace: ${requested}`);
  }
  return resolved.path;
}
