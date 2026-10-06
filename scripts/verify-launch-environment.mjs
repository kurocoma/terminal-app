// Actual Cursor / integrated PowerShell verification using an isolated profile.
// Run before building the fix: node scripts/verify-launch-environment.mjs before
// After npm run build: node scripts/verify-launch-environment.mjs fixed
// Only the five relevant variables are inspected; session IDs are never saved.
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!["before", "fixed"].includes(mode)) {
  throw new Error("Usage: node scripts/verify-launch-environment.mjs before|fixed [output-directory]");
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[3] ? resolve(process.argv[3]) : mkdtempSync(join(tmpdir(), "terminal-app-launch-env-"));
mkdirSync(outDir, { recursive: true });
const profile = join(outDir, "cursor-profile");
const extension = join(outDir, "probe-extension");
const extensions = join(outDir, "empty-extensions");
const project = join(outDir, "empty-project");
for (const dir of [profile, extension, extensions, project]) mkdirSync(dir, { recursive: true });
const terminalReport = join(outDir, "terminal.json");
const hostReport = join(outDir, "extension-host.json");
if ([terminalReport, hostReport].some(existsSync)) throw new Error("Output directory already contains probe results; use a fresh directory");
const probe = join(outDir, "probe.ps1");
const names = ["NO_COLOR", "TERM", "CODEX_CI", "CODEX_SESSION_ID", "CODEX_THREAD_ID"];
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

writeFileSync(probe, [
  "$ErrorActionPreference = 'Stop'",
  "$report = [ordered]@{}",
  `foreach ($name in @(${names.map(psQuote).join(",")})) {`,
  "  $value = [Environment]::GetEnvironmentVariable($name, 'Process')",
  "  $report[$name] = [ordered]@{ present = ($null -ne $value) }",
  "  if ($name -eq 'NO_COLOR') { $report[$name]['disablesColor'] = ($value -eq '1') }",
  "  if ($name -eq 'TERM') { $report[$name]['dumb'] = ($value -eq 'dumb') }",
  "}",
  `[IO.File]::WriteAllText(${psQuote(terminalReport)}, ($report | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))`,
].join("\r\n"), "utf8");
writeFileSync(join(extension, "package.json"), JSON.stringify({
  name: "terminal-app-environment-probe", version: "0.0.1", publisher: "local-verification",
  engines: { vscode: "^1.80.0" }, activationEvents: ["*"], main: "./extension.js",
}), "utf8");
writeFileSync(join(extension, "extension.js"), `
const vscode = require('vscode');
const fs = require('node:fs');
exports.activate = function () {
  const names = ${JSON.stringify(names)};
  const report = Object.fromEntries(names.map(name => [name, {
    present: Object.hasOwn(process.env, name),
    ...(name === 'NO_COLOR' ? { disablesColor: process.env[name] === '1' } : {}),
    ...(name === 'TERM' ? { dumb: process.env[name] === 'dumb' } : {}),
  }]));
  fs.writeFileSync(${JSON.stringify(hostReport)}, JSON.stringify(report));
  const terminal = vscode.window.createTerminal({
    name: 'Environment verification (temporary)',
    shellPath: process.env.SystemRoot + '\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe',
    shellArgs: ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass'],
  });
  terminal.show();
  terminal.sendText(${JSON.stringify(`& ${psQuote(probe)}`)}, true);
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(terminalReport)})) {
      clearInterval(timer);
      terminal.dispose();
      vscode.commands.executeCommand('workbench.action.quit');
    }
  }, 300);
};
`, "utf8");

const originalSpawn = childProcess.spawn;
let launched;
let productionEnvProvided;
childProcess.spawn = (exe, args, options) => {
  if (basename(exe).toLowerCase() !== "cursor.exe") throw new Error("Probe expected Cursor.exe");
  productionEnvProvided = options.env !== undefined;
  launched = originalSpawn(exe, [...args,
    "--new-window", "--user-data-dir", profile, "--extensions-dir", extensions,
    "--extensionDevelopmentPath", extension, "--disable-workspace-trust",
    "--skip-welcome", "--skip-release-notes",
  ], options);
  return launched;
};
const oldEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const fixture = { NO_COLOR: "1", TERM: "dumb", CODEX_CI: "1", CODEX_SESSION_ID: "synthetic-probe-session", CODEX_THREAD_ID: "synthetic-probe-thread" };
let outcome;
try {
  Object.assign(process.env, fixture);
  const require = createRequire(import.meta.url);
  const { launchProjectApp } = require(join(root, "dist", "main", "app-launcher.js"));
  outcome = launchProjectApp("cursor", project);
} finally {
  childProcess.spawn = originalSpawn;
  for (const name of names) {
    if (oldEnv[name] === undefined) delete process.env[name];
    else process.env[name] = oldEnv[name];
  }
}
if (!outcome?.ok || !launched) throw new Error("Production launcher did not start Cursor");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const deadline = Date.now() + 90000;
while ((!existsSync(terminalReport) || !existsSync(hostReport)) && Date.now() < deadline) await sleep(300);
if (!existsSync(terminalReport) || !existsSync(hostReport)) {
  // The PID belongs to this isolated invocation; existing Cursor instances are untouched.
  childProcess.spawnSync("taskkill.exe", ["/PID", String(launched.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  throw new Error(`Cursor probe timed out. Isolated output: ${outDir}`);
}
const terminal = JSON.parse(readFileSync(terminalReport, "utf8"));
const extensionHost = JSON.parse(readFileSync(hostReport, "utf8"));
const passes = (report) => mode === "before"
  ? names.every((name) => report[name].present) && report.NO_COLOR.disablesColor && report.TERM.dumb
  : !report.NO_COLOR.present && !report.TERM.dumb && names.slice(2).every((name) => !report[name].present);
const result = { mode, passed: passes(terminal) && passes(extensionHost), productionEnvProvided, terminal, extensionHost };
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
for (let i = 0; i < 10 && launched.exitCode === null; i++) await sleep(300);
if (launched.exitCode === null) {
  childProcess.spawnSync("taskkill.exe", ["/PID", String(launched.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}
console.log(JSON.stringify({ mode, passed: result.passed, productionEnvProvided, outputDirectory: outDir }));
if (!result.passed) process.exitCode = 1;
