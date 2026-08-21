#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

export const DESIRED_KEY = "muse-spark-1.2-contributor";
export const DESIRED_GROUP = "openai-responses";
export const DESIRED_MODEL = {
  id: "muse-spark-1.2-contributor",
  name: "Muse Spark 1.2 Contributor",
  api: "openai-responses",
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 131072,
  compat: { sessionAffinityFormat: "openai-nosession" },
};

export function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    if (!isPlainObject(a) || !isPlainObject(b)) {
      // for non-plain objects compare via JSON? but treat strictly
      return false;
    }
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    ak.sort();
    bk.sort();
    for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return false;
    for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

function resolve(p) {
  return path.resolve(p);
}

export function isPathInside(child, parent) {
  const rChild = resolve(child);
  const rParent = resolve(parent);
  if (rChild === rParent) return true;
  const rel = path.relative(rParent, rChild);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}



async function statNoSymlink(p, expect) {
  // expect: 'dir' or 'file'
  let lst;
  try {
    lst = await fs.promises.lstat(p);
  } catch (e) {
    throw new Error(`missing ${expect}: ${p}: ${e.message}`);
  }
  if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${p}`);
  if (expect === "dir" && !lst.isDirectory()) throw new Error(`not a directory: ${p}`);
  if (expect === "file" && !lst.isFile()) throw new Error(`not a regular file: ${p}`);
  return lst;
}

export async function validateNodeModulesRoot(nodeModulesRoot) {
  const nmr = resolve(nodeModulesRoot);
  await statNoSymlink(nmr, "dir");
  const pkgs = ["@deepseek-ai/dsh", "@deepseek-ai/dsh-llm-pi-ai", "@earendil-works/pi-ai"];
  for (const pkg of pkgs) {
    const pkgJsonPath = path.join(nmr, pkg, "package.json");
    await statNoSymlink(pkgJsonPath, "file");
    const raw = await fs.promises.readFile(pkgJsonPath, "utf8");
    let j;
    try {
      j = JSON.parse(raw);
    } catch (e) {
      throw new Error(`invalid package.json ${pkg}: ${e.message}`);
    }
    if (!isPlainObject(j) || j.name !== pkg) {
      throw new Error(`package.json identity mismatch: ${pkg} at ${pkgJsonPath}`);
    }
  }
  return nmr;
}

export function getTargetPath(nodeModulesRoot) {
  return path.join(resolve(nodeModulesRoot), "@earendil-works/pi-ai/dist/providers/data/opencode-go.json");
}

export async function validateParentsAndTarget(targetPath) {
  const resolvedTarget = resolve(targetPath);
  // Explicit mutable chain without following symlinks:
  // derive nodeModulesRoot from targetPath: .../node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json
  const dataDir = path.dirname(resolvedTarget);
  const providersDir = path.dirname(dataDir);
  const distDir = path.dirname(providersDir);
  const piAiDir = path.dirname(distDir);
  const scopeEarendilDir = path.dirname(piAiDir);
  const nodeModulesRoot = path.dirname(scopeEarendilDir);
  // Validate explicit chain: nodeModulesRoot, scope dirs, package dirs already partly validated elsewhere
  // but we validate the pi-ai chain and target explicitly here without symlink following.
  // Validate nodeModulesRoot is dir (explicit ancestor)
  await statNoSymlink(nodeModulesRoot, "dir");
  await statNoSymlink(scopeEarendilDir, "dir");
  // Validate @deepseek-ai scope dir as well for completeness (explicit)
  await statNoSymlink(path.join(nodeModulesRoot, "@deepseek-ai"), "dir");
  await statNoSymlink(piAiDir, "dir");
  await statNoSymlink(path.join(nodeModulesRoot, "@deepseek-ai/dsh"), "dir");
  await statNoSymlink(path.join(nodeModulesRoot, "@deepseek-ai/dsh-llm-pi-ai"), "dir");
  await statNoSymlink(distDir, "dir");
  await statNoSymlink(providersDir, "dir");
  await statNoSymlink(dataDir, "dir");
  // Validate package.json files are regular files (no symlink)
  await statNoSymlink(path.join(nodeModulesRoot, "@deepseek-ai/dsh/package.json"), "file");
  await statNoSymlink(path.join(nodeModulesRoot, "@deepseek-ai/dsh-llm-pi-ai/package.json"), "file");
  await statNoSymlink(path.join(nodeModulesRoot, "@earendil-works/pi-ai/package.json"), "file");
  // Target file must be regular file not symlink
  try {
    const lst = await fs.promises.lstat(resolvedTarget);
    if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${resolvedTarget}`);
    if (!lst.isFile()) throw new Error(`not a regular file: ${resolvedTarget}`);
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(`target not found: ${resolvedTarget}`);
    }
    throw e;
  }
  return resolvedTarget;
}

export async function loadCatalog(targetPath) {
  const raw = await fs.promises.readFile(targetPath, "utf8");
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON catalog: ${e.message}`);
  }
  if (!isPlainObject(catalog)) throw new Error("catalog root must be a plain object");
  const group = catalog[DESIRED_GROUP];
  if (!isPlainObject(group)) throw new Error(`catalog group ${DESIRED_GROUP} must be a plain object`);
  return { catalog, raw };
}

export function validateNoConflicts(catalog) {
  for (const [groupName, groupObj] of Object.entries(catalog)) {
    if (!isPlainObject(groupObj)) continue;
    for (const [key, entry] of Object.entries(groupObj)) {
      const keyMatches = key === DESIRED_KEY;
      const idMatches = isPlainObject(entry) && entry.id === DESIRED_KEY;
      if (!keyMatches && !idMatches) continue;
      if (groupName !== DESIRED_GROUP || key !== DESIRED_KEY || !deepEqual(entry, DESIRED_MODEL)) {
        throw new Error(`conflicting entry for ${DESIRED_KEY} at ${groupName}.${key} (fails closed)`);
      }
    }
  }
}

export function getDesiredEntry(catalog) {
  const group = catalog[DESIRED_GROUP];
  if (!isPlainObject(group)) return undefined;
  return group[DESIRED_KEY];
}

export function isDesiredEntryExact(entry) {
  return isPlainObject(entry) && deepEqual(entry, DESIRED_MODEL);
}

async function ensureBackupDirOutside(backupDir, nodeModulesRoot) {
  const rBackup = resolve(backupDir);
  const rNmr = resolve(nodeModulesRoot);
  if (rBackup === rNmr || isPathInside(rBackup, rNmr)) {
    throw new Error(`backup dir must be outside node_modules root: ${rBackup} inside ${rNmr}`);
  }
  // Validate each existing path component from explicit existing ancestor is real directory and no component is symlink.
  // Find explicit existing ancestor by walking up until lstat succeeds.
  let existingAncestor = null;
  let cur = rBackup;
  while (true) {
    try {
      const lst = await fs.promises.lstat(cur);
      if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${cur}`);
      if (!lst.isDirectory()) throw new Error(`not a directory: ${cur}`);
      existingAncestor = cur;
      break;
    } catch (e) {
      if (e.message && e.message.startsWith("symlink not allowed")) throw e;
      if (e.message && e.message.startsWith("not a directory")) throw e;
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error(`no existing ancestor for backup dir: ${rBackup}`);
      cur = parent;
    }
  }
  // Validate that every component from existingAncestor down to rBackup's parent that exists is dir non-symlink
  // Walk from existingAncestor's child to rBackup, checking existing ones
  const rel = path.relative(existingAncestor, rBackup);
  if (rel !== "") {
    const parts = rel.split(path.sep);
    let accum = existingAncestor;
    for (const part of parts) {
      if (!part) continue;
      accum = path.join(accum, part);
      try {
        const lst = await fs.promises.lstat(accum);
        if (lst.isSymbolicLink()) throw new Error(`symlink not allowed: ${accum}`);
        if (!lst.isDirectory()) throw new Error(`not a directory: ${accum}`);
      } catch (e) {
        if (e.code === "ENOENT") {
          // missing component - will be created below; continue to check that no deeper existing component exists as symlink
          // But if this component is missing, deeper components cannot exist either, so break and create sequentially
          break;
        }
        throw e;
      }
    }
  }
  // Create missing directories sequentially (no recursive) to ensure exclusive creation and symlink check
  if (rel !== "") {
    const parts2 = rel.split(path.sep);
    let accum2 = existingAncestor;
    for (const part of parts2) {
      if (!part) continue;
      accum2 = path.join(accum2, part);
      try {
        await fs.promises.lstat(accum2);
        // already validated above
      } catch (e) {
        if (e.code === "ENOENT") {
          await fs.promises.mkdir(accum2, { recursive: false });
          await statNoSymlink(accum2, "dir");
        } else {
          throw e;
        }
      }
    }
  }
  await statNoSymlink(rBackup, "dir");
  return rBackup;
}

export async function doCheck(nodeModulesRoot) {
  const nmr = await validateNodeModulesRoot(nodeModulesRoot);
  const target = getTargetPath(nmr);
  await validateParentsAndTarget(target);
  const { catalog } = await loadCatalog(target);
  validateNoConflicts(catalog);
  const entry = getDesiredEntry(catalog);
  if (!entry) {
    return { ok: false, missing: true, reason: "missing" };
  }
  if (!isDesiredEntryExact(entry)) {
    // This would have been caught by validateNoConflicts, but keep
    throw new Error(`conflicting entry for ${DESIRED_KEY} (metadata mismatch)`);
  }
  return { ok: true, missing: false };
}

export async function doApply(nodeModulesRoot, backupDir) {
  const nmr = await validateNodeModulesRoot(nodeModulesRoot);
  const target = getTargetPath(nmr);
  await validateParentsAndTarget(target);
  const { catalog, raw: originalRaw } = await loadCatalog(target);
  validateNoConflicts(catalog);
  const entry = getDesiredEntry(catalog);
  if (entry && isDesiredEntryExact(entry)) {
    return { ok: true, idempotent: true };
  }
  if (entry) {
    // Should have failed in validateNoConflicts, but double-check
    throw new Error(`conflicting entry exists, cannot apply`);
  }
  // Need to apply: preserve all other parsed values and entries
  // Make unique timestamped backup under explicit backup dir which must be outside node_modules root
  const rBackup = await ensureBackupDirOutside(backupDir, nmr);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  const backupFile = path.join(rBackup, `opencode-go.json.backup.${ts}.${rand}`);
  // Safety: ensure backupFile is inside backup dir
  if (!isPathInside(backupFile, rBackup) && resolve(backupFile) !== resolve(rBackup)) {
    throw new Error("backup path containment violation");
  }
  // Also ensure backupFile is not inside nodeModulesRoot
  if (isPathInside(backupFile, nmr) || resolve(backupFile) === resolve(nmr)) {
    throw new Error("backup file inside node_modules root");
  }
  // Write backup exclusively so it cannot overwrite
  await fs.promises.writeFile(backupFile, originalRaw, { encoding: "utf8", flag: "wx" });
  const backupRead = await fs.promises.readFile(backupFile, "utf8");
  if (backupRead !== originalRaw) throw new Error("backup verification failed");
  await statNoSymlink(backupFile, "file");

  const newCatalog = JSON.parse(JSON.stringify(catalog));
  if (!isPlainObject(newCatalog[DESIRED_GROUP])) newCatalog[DESIRED_GROUP] = {};
  newCatalog[DESIRED_GROUP][DESIRED_KEY] = DESIRED_MODEL;

  const newRaw = JSON.stringify(newCatalog, null, 2) + "\n";
  const dir = path.dirname(target);
  const tmpName = `.opencode-go.json.tmp.${rand}.${Date.now()}`;
  const tmpPath = path.join(dir, tmpName);
  if (path.dirname(resolve(tmpPath)) !== resolve(dir)) throw new Error("tmp path containment violation");
  // Capture original permission mode to preserve
  const origStat = await fs.promises.stat(target);
  const origMode = origStat.mode & 0o777;
  let tmpCreated = false;
  try {
    await fs.promises.writeFile(tmpPath, newRaw, { encoding: "utf8", flag: "wx" });
    tmpCreated = true;
    await statNoSymlink(tmpPath, "file");
    await fs.promises.chmod(tmpPath, origMode);
    await fs.promises.rename(tmpPath, target);
  } catch (e) {
    if (tmpCreated) {
      try { await fs.promises.unlink(tmpPath); } catch {}
    }
    throw e;
  }
  // Parses and exact-validates readback
  const { catalog: readback } = await loadCatalog(target);
  validateNoConflicts(readback);
  const rbEntry = getDesiredEntry(readback);
  if (!isDesiredEntryExact(rbEntry)) throw new Error("readback validation failed");
  return { ok: true, idempotent: false, backupFile };
}

function parseArgs(argv) {
  const args = { nodeModulesRoot: null, backupDir: null, json: false, mode: null, seenCheck: 0, seenApply: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--node-modules-root") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error("missing value for --node-modules-root");
      if (args.nodeModulesRoot !== null) throw new Error("duplicate --node-modules-root");
      args.nodeModulesRoot = argv[++i];
    } else if (a.startsWith("--node-modules-root=")) {
      const v = a.slice("--node-modules-root=".length);
      if (!v) throw new Error("missing value for --node-modules-root");
      if (args.nodeModulesRoot !== null) throw new Error("duplicate --node-modules-root");
      args.nodeModulesRoot = v;
    } else if (a === "--backup-dir") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error("missing value for --backup-dir");
      if (args.backupDir !== null) throw new Error("duplicate --backup-dir");
      args.backupDir = argv[++i];
    } else if (a.startsWith("--backup-dir=")) {
      const v = a.slice("--backup-dir=".length);
      if (!v) throw new Error("missing value for --backup-dir");
      if (args.backupDir !== null) throw new Error("duplicate --backup-dir");
      args.backupDir = v;
    } else if (a === "--check") {
      args.seenCheck++;
      if (args.seenCheck > 1) throw new Error("duplicate --check");
      if (args.mode !== null) throw new Error("conflicting --check and --apply");
      args.mode = "check";
    } else if (a === "--apply") {
      args.seenApply++;
      if (args.seenApply > 1) throw new Error("duplicate --apply");
      if (args.mode !== null) throw new Error("conflicting --check and --apply");
      args.mode = "apply";
    } else if (a === "--json") {
      args.json = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (args.mode === null) args.mode = "check";
  return args;
}

async function main() {
  const jsonMode = process.argv.includes("--json");
  try {
    const opts = parseArgs(process.argv);
    if (!opts.nodeModulesRoot) throw new Error("missing required --node-modules-root PATH");
    if (opts.mode === "apply" && !opts.backupDir) throw new Error("--apply requires --backup-dir PATH");
    if (opts.mode === "check") {
      const result = await doCheck(opts.nodeModulesRoot);
      if (result.ok) {
        if (jsonMode) console.log(JSON.stringify({ ok: true, mode: "check", present: true }));
        else console.log("ok: entry present");
        process.exit(0);
      } else if (result.missing) {
        if (jsonMode) console.log(JSON.stringify({ ok: false, mode: "check", missing: true }));
        else console.log("missing: entry not found");
        process.exit(1);
      } else {
        if (jsonMode) console.log(JSON.stringify({ ok: false, mode: "check" }));
        else console.log("check failed");
        process.exit(1);
      }
    } else {
      // apply
      const result = await doApply(opts.nodeModulesRoot, opts.backupDir);
      if (jsonMode) {
        console.log(JSON.stringify({ ok: true, mode: "apply", idempotent: !!result.idempotent, backupFile: result.backupFile || null }));
      } else {
        if (result.idempotent) console.log("ok: entry already present (idempotent)");
        else console.log(`ok: patched, backup ${result.backupFile}`);
      }
      process.exit(0);
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // Never log catalog/env/settings/credentials contents - only concise error
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(`error: ${msg}`);
    }
    process.exit(1);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] || "") === resolve(__filename)) {
  main();
}
