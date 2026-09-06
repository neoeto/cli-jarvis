import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimalProcessEnvironment } from "../process/run.js";
import { CjError } from "../shared/errors.js";

const execFileAsync = promisify(execFile);

interface AclEntry {
  sid: string;
  type: string;
  rights: string;
}

interface AclReport {
  current: string;
  access: AclEntry | AclEntry[] | null;
}

const script = String.raw`
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$entries = @((Get-Acl -LiteralPath $args[0]).Access | ForEach-Object {
  try { $sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
  catch { $sid = $_.IdentityReference.Value }
  [PSCustomObject]@{ sid = $sid; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString() }
})
[PSCustomObject]@{ current = $current; access = $entries } | ConvertTo-Json -Depth 4 -Compress
`;

export async function assertSecureWindowsAcl(file: string): Promise<void> {
  if (process.platform !== "win32") return;
  let report: AclReport;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, file],
      {
        env: minimalProcessEnvironment(),
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 128 * 1024
      }
    );
    report = JSON.parse(stdout) as AclReport;
  } catch (error) {
    throw new CjError("CONFIG_INVALID", `Cannot verify credential ACL: ${file}`, { cause: error });
  }

  const allowed = new Set([report.current, "S-1-5-18", "S-1-5-32-544"]);
  const entries = report.access === null ? [] : Array.isArray(report.access) ? report.access : [report.access];
  const unsafe = entries.filter(
    (entry) => entry.type.toLowerCase() === "allow" && !allowed.has(entry.sid)
  );
  if (unsafe.length) {
    throw new CjError(
      "CONFIG_INVALID",
      `Credential file ACL permits other users (${unsafe.map((entry) => entry.sid).join(", ")}): ${file}`
    );
  }
}
