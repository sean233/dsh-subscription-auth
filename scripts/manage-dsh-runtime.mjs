#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { doApply, doCheck } from "./patch-dsh-opencode-go-muse.mjs";

export const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";
export const DSH_ENTRY_REL = "@deepseek-ai/dsh/lib/bin.js";
export const DSH_PACKAGE_JSON_REL = "@deepseek-ai/dsh/package.json";

const SEMVER_EXACT_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHELL_META_RE = /[ \t\n\r\f\v;|&$`\\"'*?<>~^(){}\[\]!#]/;

export function getDefaultRuntimeRoot() {
  return path.join(os.homedir(), ".local/share/dsh-subscription-auth/dsh-runtime");
}

export function getDefaultBackupDir() {
  return path.join(os.homedir(), ".dsh/backups/dsh-model-catalog");
}

export function isValidDshVersion(v) {
  if (typeof v !== "string") return false;
  if (v.length === 0) return false;
  // reject whitespace anywhere (including leading/trailing)
  if (/\s/.test(v)) return false;
  // reject shell syntax chars
  if (SHELL_META_RE.test(v)) return false;
  // reject if trimmed differs (covers whitespace at edges, though already checked)
  if (v.trim() !== v) return false;
  // strict semver exact
  if (!SEMVER_EXACT_RE.test(v)) return false;
  return true;
}

export function validateDshVersion(v) {
  if (!isValidDshVersion(v)) {
    throw new Error(`invalid --dsh-version: ${v}`);
  }
  return v;
}

/**
 * Build npm arguments for isolated install.
 * Exported for testing.
 */
export function buildNpmArgs(runtimeRoot, version) {
  if (!path.isAbsolute(runtimeRoot)) {
    throw new Error(`runtime root must be absolute: ${runtimeRoot}`);
  }
  const r = path.resolve(runtimeRoot);
  validateDshVersion(version);
  return ["install", "--prefix", r, "--save-exact", "--no-audit", "--no-fund", `${DSH_PACKAGE_NAME}@${version}`];
}

function isPathInside(child, parent) {
  const rc = path.resolve(child);
  const rp = path.resolve(parent);
  if (rc === rp) return false; // not inside itself
  const rel = path.relative(rp, rc);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function validateRuntimeRoot(runtimeRoot) {
  if (!path.isAbsolute(runtimeRoot)) {
    throw new Error(`runtime root must be absolute: ${runtimeRoot}`);
  }
  const home = path.resolve(os.homedir());
  const r = path.resolve(runtimeRoot);

  if (!path.isAbsolute(r)) {
    throw new Error(`runtime root must be absolute: ${runtimeRoot} -> ${r}`);
  }
  const root = path.parse(r).root;
  if (r === root) {
    throw new Error(`runtime root must not be filesystem root: ${r}`);
  }
  if (r === home) {
    throw new Error(`runtime root must not be HOME: ${r}`);
  }
  if (isPathInside(home, r)) {
    throw new Error(`runtime root must not be an ancestor of HOME: ${r} ancestor of ${home}`);
  }

  // not a symlink itself if exists
  try {
    const lst = fs.lstatSync(r);
    if (lst.isSymbolicLink()) throw new Error(`runtime root symlink not allowed: ${r}`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    // not exists yet - will check parent components below
  }

  try {
    const homeLst = fs.lstatSync(home);
    if (homeLst.isSymbolicLink()) throw new Error(`symlink not allowed: ${home}`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  if (r === home || isPathInside(r, home)) {
    const rel = path.relative(home, r);
    const parts = rel.split(path.sep).filter(Boolean);
    let cur = home;
    for (const part of parts) {
      cur = path.join(cur, part);
      try {
        const lst = fs.lstatSync(cur);
        if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${cur}`);
      } catch (e) {
        if (e.code === "ENOENT") {
          break;
        }
        throw e;
      }
    }
  }

  return r;
}

export function validateBackupDir(backupDir, runtimeRoot) {
  if (!path.isAbsolute(backupDir)) {
    throw new Error(`backup dir must be absolute: ${backupDir}`);
  }
  const b = path.resolve(backupDir);
  const home = path.resolve(os.homedir());
  if (!path.isAbsolute(b)) throw new Error(`backup dir must be absolute: ${backupDir}`);
  const root = path.parse(b).root;
  if (b === root) throw new Error(`backup dir must not be filesystem root: ${b}`);
  if (b === home) throw new Error(`backup dir must not be HOME: ${b}`);
  if (isPathInside(home, b)) throw new Error(`backup dir must not be an ancestor of HOME: ${b} ancestor of ${home}`);
  const r = path.resolve(runtimeRoot);
  if (b === r) throw new Error(`backup dir must not be runtime root: ${b}`);
  if (isPathInside(b, r)) throw new Error(`backup dir must not be inside runtime root: ${b} inside ${r}`);
  try {
    const homeLst = fs.lstatSync(home);
    if (homeLst.isSymbolicLink()) throw new Error(`symlink not allowed: ${home}`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const parts = b.split(path.sep);
  let cur = path.parse(b).root;
  let startIdx = 1;
  for (let i = startIdx; i < parts.length; i++) {
    if (!parts[i]) continue;
    cur = path.join(cur, parts[i]);
    try {
      const lst = fs.lstatSync(cur);
      if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${cur}`);
    } catch (e) {
      if (e.code === "ENOENT") break;
      throw e;
    }
  }
  try {
    const lst = fs.lstatSync(b);
    if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${b}`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return b;
}

function ensureDirAfterSafeChecks(dir) {
  const resolved = path.resolve(dir);
  const parts = resolved.split(path.sep);
  let cur = path.parse(resolved).root;
  let startIdx = 1;
  for (let i = startIdx; i < parts.length; i++) {
    if (!parts[i]) continue;
    cur = path.join(cur, parts[i]);
    try {
      const lst = fs.lstatSync(cur);
      if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${cur}`);
      if (!lst.isDirectory() && i < parts.length - 1) {
        throw new Error(`not a directory: ${cur}`);
      }
    } catch (e) {
      if (e.code === "ENOENT") {
        break;
      }
      throw e;
    }
  }
  fs.mkdirSync(resolved, { recursive: true });
  // verify created dir is not symlink
  const lst2 = fs.lstatSync(resolved);
  if (lst2.isSymbolicLink()) throw new Error(`symlink not allowed after mkdir: ${resolved}`);
  if (!lst2.isDirectory()) throw new Error(`not a directory after mkdir: ${resolved}`);
  return resolved;
}

function runNpm(npmPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmPath, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`npm terminated with signal ${signal}`));
      else if (code !== 0) reject(new Error(`npm exited with code ${code}`));
      else resolve(code);
    });
  });
}

async function verifyPackageAndBinary(runtimeRoot, expectedVersion) {
  const r = path.resolve(runtimeRoot);
  const pkgJsonPath = path.join(r, "node_modules", DSH_PACKAGE_JSON_REL);
  let lst;
  try {
    lst = await fs.promises.lstat(pkgJsonPath);
  } catch (e) {
    throw new Error(`missing package.json: ${pkgJsonPath}: ${e.message}`);
  }
  if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${pkgJsonPath}`);
  if (!lst.isFile()) throw new Error(`not a regular file: ${pkgJsonPath}`);
  const raw = await fs.promises.readFile(pkgJsonPath, "utf8");
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid package.json: ${e.message}`);
  }
  if (j.name !== DSH_PACKAGE_NAME) throw new Error(`package name mismatch: expected ${DSH_PACKAGE_NAME} got ${j.name}`);
  if (j.version !== expectedVersion) throw new Error(`package version mismatch: expected ${expectedVersion} got ${j.version}`);

  const binPath = path.join(r, "node_modules", DSH_ENTRY_REL);
  let blst;
  try {
    blst = await fs.promises.lstat(binPath);
  } catch (e) {
    throw new Error(`missing binary: ${binPath}: ${e.message}`);
  }
  if (blst.isSymbolicLink()) throw new Error(`symlink not allowed: ${binPath}`);
  if (!blst.isFile()) throw new Error(`not a regular file: ${binPath}`);

  const absEntry = path.resolve(binPath);
  return { pkgJsonPath: path.resolve(pkgJsonPath), binPath: absEntry, pkg: j };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) throw new Error("missing command: install or check");
  const command = args[0];
  if (command !== "install" && command !== "check") throw new Error(`unknown command: ${command}`);
  let dshVersion = null;
  let runtimeRoot = null;
  let npmPath = "npm";
  let backupDir = null;
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--dsh-version") {
      if (i + 1 >= args.length) throw new Error("missing value for --dsh-version");
      dshVersion = args[++i];
    } else if (a.startsWith("--dsh-version=")) {
      dshVersion = a.slice("--dsh-version=".length);
    } else if (a === "--runtime-root") {
      if (i + 1 >= args.length) throw new Error("missing value for --runtime-root");
      runtimeRoot = args[++i];
    } else if (a.startsWith("--runtime-root=")) {
      runtimeRoot = a.slice("--runtime-root=".length);
    } else if (a === "--npm-path") {
      if (i + 1 >= args.length) throw new Error("missing value for --npm-path");
      npmPath = args[++i];
    } else if (a.startsWith("--npm-path=")) {
      npmPath = a.slice("--npm-path=".length);
    } else if (a === "--backup-dir") {
      if (i + 1 >= args.length) throw new Error("missing value for --backup-dir");
      backupDir = args[++i];
    } else if (a.startsWith("--backup-dir=")) {
      backupDir = a.slice("--backup-dir=".length);
    } else if (a === "--json") {
      json = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (dshVersion === null || dshVersion === "") throw new Error("missing required --dsh-version");
  // validate version strictly
  validateDshVersion(dshVersion);

  if (!runtimeRoot) runtimeRoot = getDefaultRuntimeRoot();
  if (!backupDir) backupDir = getDefaultBackupDir();
  const resolvedRuntime = validateRuntimeRoot(runtimeRoot);
  const resolvedBackup = validateBackupDir(backupDir, resolvedRuntime);

  return { command, dshVersion, runtimeRoot: resolvedRuntime, npmPath, backupDir: resolvedBackup, json };
}

async function doInstall(opts) {
  ensureDirAfterSafeChecks(opts.runtimeRoot);
  ensureDirAfterSafeChecks(opts.backupDir);

  const npmArgs = buildNpmArgs(opts.runtimeRoot, opts.dshVersion);
  await runNpm(opts.npmPath, npmArgs);
  const verified = await verifyPackageAndBinary(opts.runtimeRoot, opts.dshVersion);
  const nodeModulesRoot = path.join(opts.runtimeRoot, "node_modules");
  const patchResult = await doApply(nodeModulesRoot, opts.backupDir);

  return { verified, patchResult, entry: verified.binPath };
}

async function doCheckCmd(opts) {
  const verified = await verifyPackageAndBinary(opts.runtimeRoot, opts.dshVersion);
  const nodeModulesRoot = path.join(opts.runtimeRoot, "node_modules");
  const checkResult = await doCheck(nodeModulesRoot);
  if (!checkResult.ok) {
    throw new Error(`check failed: entry missing at ${verified.binPath}`);
  }
  return { verified, checkResult, entry: verified.binPath };
}

async function main() {
  const jsonMode = process.argv.includes("--json");
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (e) {
    const msg = e.message || String(e);
    if (jsonMode) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`error: ${msg}`);
    process.exit(1);
  }
  try {
    if (opts.command === "install") {
      const result = await doInstall(opts);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, command: "install", version: opts.dshVersion, runtimeRoot: opts.runtimeRoot, entry: result.entry, backupFile: result.patchResult.backupFile || null, idempotent: !!result.patchResult.idempotent }));
      } else {
        console.log(`ok: installed ${DSH_PACKAGE_NAME}@${opts.dshVersion}`);
        console.log(`runtime: ${opts.runtimeRoot}`);
        console.log(`entry: ${result.entry}`);
        if (result.patchResult.backupFile) console.log(`backup: ${result.patchResult.backupFile}`);
        else if (result.patchResult.idempotent) console.log(`patch: idempotent`);
      }
      process.exit(0);
    } else {
      const result = await doCheckCmd(opts);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, command: "check", version: opts.dshVersion, runtimeRoot: opts.runtimeRoot, entry: result.entry, present: true }));
      } else {
        console.log(`ok: ${DSH_PACKAGE_NAME}@${opts.dshVersion} present`);
        console.log(`entry: ${result.entry}`);
        console.log(`check: ok`);
      }
      process.exit(0);
    }
  } catch (e) {
    const msg = e.message || String(e);
    if (opts && opts.json) {
      console.log(JSON.stringify({ ok: false, command: opts.command, error: msg, entry: null }));
    } else if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(`error: ${msg}`);
    }
    process.exit(1);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || "") === path.resolve(__filename)) {
  main();
}
