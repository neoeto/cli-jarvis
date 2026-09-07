import os from "node:os";
import path from "node:path";

export interface AppPaths {
  configDir: string;
  stateDir: string;
  configFile: string;
  authFile: string;
  historyFile: string;
  memoryFile: string;
  toolsDir: string;
}

export function getAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const override = env.CJ_CONFIG_DIR;
  let configDir: string;
  let stateDir: string;

  if (override) {
    configDir = path.resolve(override);
    stateDir = configDir;
  } else if (process.platform === "darwin") {
    configDir = path.join(os.homedir(), "Library", "Application Support", "cj");
    stateDir = configDir;
  } else if (process.platform === "win32") {
    configDir = path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "cj");
    stateDir = configDir;
  } else {
    configDir = path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "cj");
    stateDir = path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "cj");
  }

  return {
    configDir,
    stateDir,
    configFile: path.join(configDir, "config.json"),
    authFile: path.join(configDir, "auth.json"),
    historyFile: path.join(stateDir, "history.jsonl"),
    memoryFile: path.join(stateDir, "memory.json"),
    toolsDir: path.join(configDir, "tools")
  };
}
