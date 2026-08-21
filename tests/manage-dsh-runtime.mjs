#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  isValidDshVersion,
  validateDshVersion,
  buildNpmArgs,
  validateRuntimeRoot,
  validateBackupDir,
  DSH_PACKAGE_NAME,
  DSH_ENTRY_REL,
  DSH_PACKAGE_JSON_REL,
} from "../scripts/manage-dsh-runtime.mjs";

import {
  DESIRED_KEY,
  DESIRED_GROUP,
  DESIRED_MODEL,
  doCheck,
  doApply,
  validateNodeModulesRoot,
  getTargetPath,
} from "../scripts/patch-dsh-opencode-go-muse.mjs";

// ---------- helpers ----------
const realTmpBase = fs.realpathSync(os.tmpdir());
const tmpRoot = fs.mkdtempSync(path.join(realTmpBase, "dsh-test-"));
function assertValidTmpRoot(p) {
  const realTmp = fs.realpathSync(os.tmpdir());
  const rp = fs.realpathSync(p);
  if (rp !== realTmp && !rp.startsWith(realTmp + path.sep)) {
    throw new Error(`tmpRoot not under os.tmpdir: ${rp} vs ${realTmp}`);
  }
  const lst = fs.lstatSync(rp);
  if (!lst.isDirectory()) throw new Error(`tmpRoot not dir: ${rp}`);
}
assertValidTmpRoot(tmpRoot);
const realTmpRoot = fs.realpathSync(tmpRoot);

let passed = 0, failed = 0;
const failures = [];
function ok(name, fn) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`PASS ${name}`);
    } catch (e) {
      failed++;
      const msg = e && e.stack ? e.stack : String(e);
      failures.push({ name, msg });
      console.error(`FAIL ${name}: ${e.message || e}`);
    }
  })();
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assert failed"); }
function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; if (msg && !String(e.message).includes(msg)) throw new Error(`expected throw containing "${msg}" got "${e.message}"`); }
  if (!threw) throw new Error(`expected throw ${msg||""}`);
}
async function assertThrowsAsync(fn, msg) {
  let threw = false;
  try { await fn(); } catch (e) { threw = true; if (msg && !String(e.message).includes(msg)) throw new Error(`expected throw containing "${msg}" got "${e.message}" got ${e.stack}`); }
  if (!threw) throw new Error(`expected async throw ${msg||""}`);
}
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function makeMinimalCatalog(extra={}) {
  return { "openai-responses": { ...extra } };
}

// record file and fake npm must remain under test temp root
const recordFile = path.join(tmpRoot, "npm-argv-record.json");
const fakeNpmPath = path.join(tmpRoot, "fake-npm.mjs");

// create fake executable npm that records argv and creates minimal runtime tree/catalog
const fakeNpmContent = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const recordFile = process.env.FAKE_NPM_RECORD;
const args = process.argv.slice(2);
// record argv
fs.writeFileSync(recordFile, JSON.stringify(args), "utf8");
// parse --prefix
let prefix = null;
for (let i=0;i<args.length;i++) {
  if (args[i]==="--prefix" && i+1<args.length) prefix = args[i+1];
  if (args[i].startsWith("--prefix=")) prefix = args[i].slice("--prefix=".length);
}
let spec = args[args.length-1];
let version = "0.0.0";
const at = spec.lastIndexOf("@");
if (at !== -1) version = spec.slice(at+1);
if (!prefix) { console.error("no prefix"); process.exit(1); }
// create tree
const pkgDir = path.join(prefix, "node_modules", "@deepseek-ai", "dsh");
const binPath = path.join(pkgDir, "lib", "bin.js");
const pkgJsonPath = path.join(pkgDir, "package.json");
fs.mkdirSync(path.dirname(binPath), { recursive: true });
fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: "@deepseek-ai/dsh", version }, null, 2));
fs.writeFileSync(binPath, "#!/usr/bin/env node\\nconsole.log('dsh');");
fs.chmodSync(binPath, 0o755);
// also create other pkgs required for overlay patch
const other1 = path.join(prefix, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "package.json");
fs.mkdirSync(path.dirname(other1), { recursive: true });
fs.writeFileSync(other1, JSON.stringify({ name: "@deepseek-ai/dsh-llm-pi-ai", version: "1.0.0" }, null, 2));
const other2 = path.join(prefix, "node_modules", "@earendil-works", "pi-ai", "package.json");
fs.mkdirSync(path.dirname(other2), { recursive: true });
fs.writeFileSync(other2, JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.0.0" }, null, 2));
const catalogPath = path.join(prefix, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data", "opencode-go.json");
fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
// if not exists, write empty catalog
if (!fs.existsSync(catalogPath)) {
  fs.writeFileSync(catalogPath, JSON.stringify({"openai-responses": {}}, null, 2));
}
process.exit(0);
`;
fs.writeFileSync(fakeNpmPath, fakeNpmContent, { mode: 0o755 });
fs.chmodSync(fakeNpmPath, 0o755);

const manageScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/manage-dsh-runtime.mjs");
function extractJson(str) {
  if (!str) return null;
  const lines = str.split("\n").map(s=>s.trim()).filter(Boolean);
  for (let i = lines.length -1; i>=0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  try { return JSON.parse(str); } catch { return null; }
}
function runManage(args, envExtra={}) {
  const env = { ...process.env, ...envExtra };
  const res = spawnSync(process.execPath, [manageScript, ...args], { encoding: "utf8", env });
  return res;
}

async function runAll() {
  // 1 semver exact acceptance
  await ok("semver exact acceptance", () => {
    assert(isValidDshVersion("1.2.3") === true);
    assert(isValidDshVersion("0.0.1") === true);
    assert(isValidDshVersion("10.20.30") === true);
    assert(isValidDshVersion("1.2.3-alpha") === true);
    assert(isValidDshVersion("1.2.3-alpha.1") === true);
    assert(isValidDshVersion("1.2.3-0.3.7") === true);
    assert(isValidDshVersion("1.2.3-x.7.z.92") === true);
    assert(isValidDshVersion("1.0.0-alpha+001") === false, "build metadata should reject");
    // prerelease with hyphen identifiers
    assert(isValidDshVersion("1.2.3-a-b-c") === true);
  });

  await ok("semver rejection tags/ranges/whitespace/shell-like", () => {
    const bad = [
      "latest","next","v1.2.3","1.2","1.2.3.4","1.2.3+build",
      "^1.2.3","~1.2.3",">=1.2.3","*","1.x","1.2.x",
      " 1.2.3","1.2.3 ","\t1.2.3","1.2.3\n","",
      "1.2.3; rm -rf","1.2.3|cat","1.2.3&","1.2.3$HOME","1.2.3`echo`","1.2.3\\","1.2.3\"","1.2.3'","1.2.3*","1.2.3?","1.2.3<","1.2.3>","1.2.3~","1.2.3^","1.2.3(","1.2.3)","1.2.3{","1.2.3}","[1.2.3","[1.2.3]","1.2.3!","1.2.3#","1.2.3;","01.2.3",
      "1.02.3","1.2.03",
    ];
    for (const v of bad) {
      assert(isValidDshVersion(v) === false, `should reject ${JSON.stringify(v)}`);
      assertThrows(() => validateDshVersion(v));
    }
  });

  await ok("npm argument construction exactness", () => {
    const rt = path.join(tmpRoot, "runtime-npm-args");
    const ver = "1.2.3";
    const expected = ["install","--prefix", path.resolve(rt), "--save-exact","--no-audit","--no-fund", `${DSH_PACKAGE_NAME}@${ver}`];
    const a1 = buildNpmArgs(rt, ver);
    assert(JSON.stringify(a1) === JSON.stringify(expected), `a1 mismatch ${JSON.stringify(a1)}`);
    const ver2 = "2.0.0-alpha.1";
    const exp2 = ["install","--prefix", path.resolve(rt), "--save-exact","--no-audit","--no-fund", `${DSH_PACKAGE_NAME}@${ver2}`];
    assert(JSON.stringify(buildNpmArgs(rt, ver2)) === JSON.stringify(exp2));
    assertThrows(() => buildNpmArgs(rt, "latest"));
    assertThrows(() => buildNpmArgs(rt, " 1.2.3"));
  });

  await ok("runtime-root rejection for root, HOME, ancestor of HOME", () => {
    const home = path.resolve(os.homedir());
    const root = path.parse(home).root;
    assertThrows(() => validateRuntimeRoot(root), "filesystem root");
    assertThrows(() => validateRuntimeRoot(home), "HOME");
    const ancestor = path.dirname(home);
    // ancestor may be root if HOME is / ; if so ancestor is root already tested; else should be rejected
    if (ancestor !== home && ancestor !== root) {
      assertThrows(() => validateRuntimeRoot(ancestor), "ancestor");
    } else if (ancestor !== home) {
      // if HOME has a parent directory, that parent is still an ancestor of HOME
      assertThrows(() => validateRuntimeRoot(ancestor), "ancestor");
    }
    // grand ancestor also
    const grand = path.dirname(ancestor);
    if (grand && grand !== ancestor && grand.length > 1) {
      // only if still ancestor (is HOME inside grand)
      const rel = path.relative(grand, home);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        assertThrows(() => validateRuntimeRoot(grand), "ancestor");
      }
    }
    // valid path should pass (inside tmpRoot)
    const valid = path.join(tmpRoot, "valid-runtime");
    const resolved = validateRuntimeRoot(valid);
    assert(resolved === path.resolve(valid));
  });

  await ok("relative path rejection", () => {
    assertThrows(() => validateRuntimeRoot("relative/path"));
    assertThrows(() => validateRuntimeRoot("./relative"));
    assertThrows(() => validateBackupDir("relative/backup", path.join(tmpRoot, "rt")));
    assertThrows(() => validateBackupDir("./backup", path.join(tmpRoot, "rt")));
    assertThrows(() => buildNpmArgs("relative/path", "1.2.3"));
    const r = runManage(["install","--dsh-version","1.2.3","--runtime-root","relative/path","--backup-dir", path.join(tmpRoot, "b"), "--npm-path", fakeNpmPath, "--json"]);
    assert(r.status !== 0, "relative runtime-root via CLI should fail");
    const r2 = runManage(["install","--dsh-version","1.2.3","--runtime-root", path.join(tmpRoot, "rt2"), "--backup-dir","relative/backup","--npm-path", fakeNpmPath, "--json"]);
    assert(r2.status !== 0, "relative backup-dir via CLI should fail");
  });

  await ok("backup dir containment and root guards", () => {
    const home = path.resolve(os.homedir());
    const root = path.parse(home).root;
    const rt = path.join(tmpRoot, "rt-contain");
    assertThrows(() => validateBackupDir(root, rt));
    assertThrows(() => validateBackupDir(home, rt));
    const ancestor = path.dirname(home);
    if (ancestor !== home) {
      assertThrows(() => validateBackupDir(ancestor, rt));
    }
    assertThrows(() => validateBackupDir(rt, rt));
    assertThrows(() => validateBackupDir(path.join(rt, "inside"), rt));
    assertThrows(() => validateBackupDir(path.join(rt, "a/b/c"), rt));
    const validOutside = path.join(tmpRoot, "valid-backup-outside");
    const res = validateBackupDir(validOutside, rt);
    assert(res === path.resolve(validOutside));
  });

  await ok("backup dir symlink rejection", () => {
    const rt = path.join(tmpRoot, "rt-backup-sym");
    const base = fs.mkdtempSync(path.join(realTmpBase, "dsh-backup-sym-"));
    try {
      const realDir = path.join(base, "real");
      fs.mkdirSync(realDir);
      const link = path.join(base, "link");
      fs.symlinkSync(realDir, link);
      const backupViaLink = path.join(link, "backup");
      assertThrows(() => validateBackupDir(backupViaLink, rt), "symlink");
      const target = path.join(base, "target");
      fs.mkdirSync(target);
      const linkBackup = path.join(base, "linkBackup");
      fs.symlinkSync(target, linkBackup);
      assertThrows(() => validateBackupDir(linkBackup, rt), "symlink");
    } finally {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    }
  });

  await ok("symlink component rejection", () => {
    // runtime inside HOME with symlink component should be rejected
    const home = path.resolve(os.homedir());
    // create a unique dir under HOME under tmpRoot alternative? Use HOME-based temp
    const base = fs.mkdtempSync(path.join(home, ".dsh-test-sym-"));
    // we must clean this base manually after test (but only validated test temp root is auto-cleaned; this is outside, so clean here)
    let cleanedBase = false;
    try {
      const realDir = path.join(base, "real");
      fs.mkdirSync(realDir);
      const link = path.join(base, "link");
      fs.symlinkSync(realDir, link);
      const runtimeViaLink = path.join(link, "runtime");
      assertThrows(() => validateRuntimeRoot(runtimeViaLink), "symlink");
      // also directly symlink runtime root itself
      const target = path.join(base, "target");
      fs.mkdirSync(target);
      const linkRuntime = path.join(base, "linkRuntime");
      fs.symlinkSync(target, linkRuntime);
      assertThrows(() => validateRuntimeRoot(linkRuntime), "symlink");
    } finally {
      // cleanup HOME-based temp (rm -rf)
      try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    }
    // also test that non-existent path with symlink parent is rejected (already covered)
  });

  await ok("exact package version/identity and regular entry verification", async () => {
    const rt = path.join(tmpRoot, "verify-pkg");
    const nodeModules = path.join(rt, "node_modules");
    // create valid package and binary
    const pkgDir = path.join(nodeModules, "@deepseek-ai/dsh");
    fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "9.9.9" }, null, 2));
    fs.writeFileSync(path.join(pkgDir, "lib/bin.js"), "console.log('hi')");
    // need overlay catalog to make check pass - create minimal valid catalog with desired entry missing? For doCheck we test missing vs present
    // First test manage check with exact version should succeed when entry present? We'll test verifyPackageAndBinary via manage check failure when overlay missing
    // Create other required pkgs and catalog with desired entry
    const mkCatalog = (withEntry) => {
      const other1 = path.join(nodeModules, "@deepseek-ai/dsh-llm-pi-ai/package.json");
      fs.mkdirSync(path.dirname(other1), { recursive: true });
      fs.writeFileSync(other1, JSON.stringify({ name: "@deepseek-ai/dsh-llm-pi-ai", version: "1.0.0" }, null, 2));
      const other2 = path.join(nodeModules, "@earendil-works/pi-ai/package.json");
      fs.mkdirSync(path.dirname(other2), { recursive: true });
      fs.writeFileSync(other2, JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.0.0" }, null, 2));
      const catalogPath = path.join(nodeModules, "@earendil-works/pi-ai/dist/providers/data/opencode-go.json");
      fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
      const cat = { "openai-responses": {} };
      if (withEntry) cat["openai-responses"][DESIRED_KEY] = JSON.parse(JSON.stringify(DESIRED_MODEL));
      fs.writeFileSync(catalogPath, JSON.stringify(cat, null, 2));
    };
    mkCatalog(true);
    // check should succeed (no throw) via doCheck directly
    const res = await doCheck(nodeModules);
    assert(res.ok === true);
    // mismatched version should fail via manage check
    const r = runManage(["check","--dsh-version","1.0.0","--runtime-root", rt, "--json"]);
    assert(r.status !== 0, "should fail version mismatch");
    const out = extractJson(r.stdout || r.stderr) || {};
    // identity mismatch: change package name
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "other", version: "9.9.9" }, null, 2));
    const r2 = runManage(["check","--dsh-version","9.9.9","--runtime-root", rt, "--json"]);
    assert(r2.status !== 0, "should fail name mismatch");
    // restore correct name but make bin a symlink -> should fail regular file check
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "9.9.9" }, null, 2));
    const binPath = path.join(pkgDir, "lib/bin.js");
    fs.rmSync(binPath);
    const realBin = path.join(pkgDir, "lib/real-bin.js");
    fs.writeFileSync(realBin, "real");
    fs.symlinkSync(realBin, binPath);
    const r3 = runManage(["check","--dsh-version","9.9.9","--runtime-root", rt, "--json"]);
    assert(r3.status !== 0, "should fail symlink bin");
    assert(String(r3.stdout+r3.stderr).includes("symlink"), "should mention symlink");
    // restore regular file
    fs.rmSync(binPath);
    fs.writeFileSync(binPath, "console.log('hi')");
    // also test symlink package.json
    const pkgJson = path.join(pkgDir, "package.json");
    const realPkg = path.join(pkgDir, "package.json.real");
    fs.renameSync(pkgJson, realPkg);
    fs.symlinkSync(realPkg, pkgJson);
    const r4 = runManage(["check","--dsh-version","9.9.9","--runtime-root", rt, "--json"]);
    assert(r4.status !== 0, "should fail symlink package.json");
  });

  await ok("check no mutation", async () => {
    const rt = path.join(tmpRoot, "check-no-mut");
    const nmr = path.join(rt, "node_modules");
    const pkgDir = path.join(nmr, "@deepseek-ai/dsh");
    fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "1.2.3" }, null, 2));
    fs.writeFileSync(path.join(pkgDir, "lib/bin.js"), "hi");
    const other1 = path.join(nmr, "@deepseek-ai/dsh-llm-pi-ai/package.json");
    fs.mkdirSync(path.dirname(other1), { recursive: true });
    fs.writeFileSync(other1, JSON.stringify({ name: "@deepseek-ai/dsh-llm-pi-ai", version: "1.0.0" }, null, 2));
    const other2 = path.join(nmr, "@earendil-works/pi-ai/package.json");
    fs.mkdirSync(path.dirname(other2), { recursive: true });
    fs.writeFileSync(other2, JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.0.0" }, null, 2));
    const catalogPath = path.join(nmr, "@earendil-works/pi-ai/dist/providers/data/opencode-go.json");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    const cat = { "openai-responses": {} };
    fs.writeFileSync(catalogPath, JSON.stringify(cat, null, 2));
    const before = fs.readFileSync(catalogPath, "utf8");
    const beforeStat = fs.statSync(catalogPath);
    const r = runManage(["check","--dsh-version","1.2.3","--runtime-root", rt, "--json"]);
    // check may fail due to missing entry, but should still not mutate
    const after = fs.readFileSync(catalogPath, "utf8");
    assert(before === after, "check mutated catalog");
    // also no backup created
    const backupDir = path.join(tmpRoot, "backup-check-no-mut");
    // ensure not created
    assert(!fs.existsSync(backupDir) || fs.readdirSync(backupDir).length===0);
  });

  await ok("missing overlay failure", async () => {
    const rt = path.join(tmpRoot, "missing-overlay");
    const nmr = path.join(rt, "node_modules");
    const pkgDir = path.join(nmr, "@deepseek-ai/dsh");
    fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "2.0.0" }, null, 2));
    fs.writeFileSync(path.join(pkgDir, "lib/bin.js"), "hi");
    // intentionally do not create overlay files
    const r = runManage(["check","--dsh-version","2.0.0","--runtime-root", rt, "--json"]);
    assert(r.status !== 0, "missing overlay should fail");
    const txt = (r.stdout||"") + (r.stderr||"");
    assert(txt.includes("missing") || txt.includes("package.json") || txt.includes("ok")===false);
  });

  await ok("install behavior without network fake executable records argv and creates tree", async () => {
    const rt = path.join(realTmpRoot, "install-fake");
    const backupDir = path.join(realTmpRoot, "backup-install-fake");
    const ver = "3.4.5";
    // ensure record file clean
    try { fs.unlinkSync(recordFile); } catch {}
    const envExtra = { FAKE_NPM_RECORD: recordFile };
    const r = runManage(["install","--dsh-version",ver,"--runtime-root",rt,"--backup-dir",backupDir,"--npm-path",fakeNpmPath,"--json"], envExtra);
    assert(r.status === 0, `install failed: stdout=${r.stdout} stderr=${r.stderr}`);
    // fake executable and record file must remain under test temp root
    assert(fs.existsSync(fakeNpmPath), "fake npm missing");
    assert(fakeNpmPath.startsWith(tmpRoot), "fake npm not under tmpRoot");
    assert(fs.existsSync(recordFile), "record file missing");
    assert(recordFile.startsWith(tmpRoot), "record file not under tmpRoot");
    const recorded = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    const expectedArgs = ["install","--prefix", path.resolve(rt), "--save-exact","--no-audit","--no-fund", `${DSH_PACKAGE_NAME}@${ver}`];
    assert(JSON.stringify(recorded) === JSON.stringify(expectedArgs), `argv mismatch recorded=${JSON.stringify(recorded)} expected=${JSON.stringify(expectedArgs)}`);
    // verify that install passed required argv without shell -> spawn with shell:false is internal, we verify argv exactness already
    // verify backup outside node_modules
    assert(fs.existsSync(backupDir), "backup dir not created");
    const backups = fs.readdirSync(backupDir);
    assert(backups.length === 1, `expected 1 backup file got ${backups}`);
    const backupFile = path.join(backupDir, backups[0]);
    assert(path.resolve(backupFile).startsWith(path.resolve(backupDir)), "backup not inside backupDir");
    assert(!path.resolve(backupFile).startsWith(path.resolve(path.join(rt, "node_modules"))), "backup inside node_modules");
    // verify exact Muse entry applied
    const catalogPath = path.join(rt, "node_modules", "@earendil-works/pi-ai/dist/providers/data/opencode-go.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    assert(catalog[DESIRED_GROUP] && catalog[DESIRED_GROUP][DESIRED_KEY], "desired entry missing after install");
    const entry = catalog[DESIRED_GROUP][DESIRED_KEY];
    assert(JSON.stringify(entry) === JSON.stringify(DESIRED_MODEL), `entry mismatch ${JSON.stringify(entry)}`);
    // verify json output contains entry path and backupFile
    const out = extractJson(r.stdout) || extractJson(r.stderr);
    assert(out && out.ok === true, "json ok false");
    assert(out.entry === path.resolve(path.join(rt, "node_modules", DSH_ENTRY_REL)), "entry path mismatch");
    assert(out.backupFile === path.resolve(backupFile), "backupFile path mismatch");
    // second install should be idempotent (no new backup) - fake npm will reset catalog? Our fake npm overwrites catalog only if not exists, but second run will keep entry, so backup should not increase
    // Need to make fake npm not overwrite catalog if exists (it already does check). So second install should be idempotent.
    const beforeBackups = fs.readdirSync(backupDir).length;
    const r2 = runManage(["install","--dsh-version",ver,"--runtime-root",rt,"--backup-dir",backupDir,"--npm-path",fakeNpmPath,"--json"], envExtra);
    // Note: fake npm will be run again but it won't overwrite catalog (since exists), and doApply will be idempotent, so no new backup
    assert(r2.status === 0, `second install failed ${r2.stdout} ${r2.stderr}`);
    const out2 = extractJson(r2.stdout) || extractJson(r2.stderr);
    assert(out2 && out2.idempotent === true, "second install should be idempotent");
    const afterBackups = fs.readdirSync(backupDir).length;
    assert(beforeBackups === afterBackups, "backup count should not increase on idempotent");
  });

  // prerelease install variant
  await ok("install with prerelease version", async () => {
    const rt = path.join(realTmpRoot, "install-prerelease");
    const backupDir = path.join(realTmpRoot, "backup-prerelease");
    const ver = "1.0.0-alpha.1";
    try { fs.unlinkSync(recordFile); } catch {}
    const r = runManage(["install","--dsh-version",ver,"--runtime-root",rt,"--backup-dir",backupDir,"--npm-path",fakeNpmPath,"--json"], { FAKE_NPM_RECORD: recordFile });
    assert(r.status === 0, `prerelease install failed ${r.stdout} ${r.stderr}`);
    const recorded = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    assert(recorded.includes(`${DSH_PACKAGE_NAME}@${ver}`));
    const catalog = JSON.parse(fs.readFileSync(path.join(rt, "node_modules", "@earendil-works/pi-ai/dist/providers/data/opencode-go.json"), "utf8"));
    assert(JSON.stringify(catalog[DESIRED_GROUP][DESIRED_KEY]) === JSON.stringify(DESIRED_MODEL));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.error("Failures:");
    for (const f of failures) console.error(f.name, f.msg.split("\n").slice(0,5).join("\n"));
  }
  // clean only validated test temp root
  assertValidTmpRoot(tmpRoot);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  // also verify fake executable and record file were under temp root (already) and now cleaned
  process.exit(failed === 0 ? 0 : 1);
}

runAll().catch(e => {
  console.error(e);
  try { assertValidTmpRoot(tmpRoot); fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
