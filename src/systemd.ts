import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function serviceName(slug: string): string {
  return `oni-${slug}.service`;
}

export function timerName(slug: string): string {
  return `oni-${slug}.timer`;
}

export function writeSystemdUnits(options: {
  slug: string;
  intervalMinutes: number;
  home: string;
  cycleCommand: string;
}): void {
  writeFileSync(join("/etc/systemd/system", serviceName(options.slug)), `[Unit]
Description=ONI newsletter ingest (${options.slug})

[Service]
Type=oneshot
Environment=ONI_HOME=${options.home}
ExecStart=${options.cycleCommand} --home ${options.home} ${options.slug}
`);

  writeFileSync(join("/etc/systemd/system", timerName(options.slug)), `[Unit]
Description=Run ONI newsletter ingest (${options.slug}) every ${options.intervalMinutes} minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${options.intervalMinutes}min
Unit=${serviceName(options.slug)}

[Install]
WantedBy=timers.target
`);
}

export function systemctl(...args: string[]): void {
  const result = spawnSync("systemctl", args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`systemctl ${args.join(" ")} failed`);
}

export function systemctlOutput(...args: string[]): string {
  const result = spawnSync("systemctl", args, { encoding: "utf8" });
  if (result.status !== 0) return "unknown";
  return result.stdout.trim() || "unknown";
}

export function journalctl(args: string[]): void {
  spawnSync("journalctl", args, { stdio: "inherit" });
}
