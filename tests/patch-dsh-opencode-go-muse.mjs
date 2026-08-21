#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

// Import production under test
import {
  DESIRED_KEY,
  DESIRED_GROUP,
  DESIRED_MODEL,
  LEGACY_MODEL,
  THINKING_LEVEL_MAP,
  deepEqual,
  isPlainObject,

  doCheck,
  doApply,
  getTargetPath,
} from "../scripts/patch-dsh-opencode-go-muse.mjs";

const TMP_PREFIX = "dsh-muse-test-";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEqual(a, b, msg) {
  if (!deepEqual(a, b)) throw new Error(msg || `not equal: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

let PASS = 0;
let FAIL = 0;
function ok(name) { PASS++; console.log(`✓ ${name}`); }
function fail(name, e) { FAIL++; console.error(`✗ ${name}: ${e.message}\n${e.stack || ""}`); }

// ---- temp root management ----

function createTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  return dir;
}

function isValidTempRoot(p) {
  const resolved = path.resolve(p);
  const tmp = path.resolve(os.tmpdir());
  const base = path.basename(resolved);
  if (!base.startsWith(TMP_PREFIX)) return false;
  // must be inside os.tmpdir
  const rel = path.relative(tmp, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel) && rel !== "" ) {
    // actually check isPathInside
  }
  // ensure inside tmpdir
  if (resolved === tmp) return false;
  if (!resolved.startsWith(tmp + path.sep)) return false;
  try {
    const lst = fs.lstatSync(resolved);
    if (lst.isSymbolicLink()) return false;
    if (!lst.isDirectory()) return false;
  } catch { return false; }
  return true;
}

function cleanTempRoot(root) {
  if (!isValidTempRoot(root)) throw new Error(`refuse to clean invalid temp root: ${root}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- fake node_modules construction ----

function makeFakeNodeModules(root, opts = {}) {
  const nmr = path.join(root, "node_modules");
  fs.mkdirSync(nmr, { recursive: true });
  const pkgs = ["@deepseek-ai/dsh", "@deepseek-ai/dsh-llm-pi-ai", "@earendil-works/pi-ai"];
  for (const pkg of pkgs) {
    const pkgDir = path.join(nmr, pkg);
    fs.mkdirSync(pkgDir, { recursive: true });
    const name = opts.invalidPkg === pkg ? "wrong-name" : pkg;
    const extra = opts.invalidPkgJsonContent?.[pkg] ?? null;
    let content;
    if (extra !== null) {
      content = extra; // raw string
      fs.writeFileSync(path.join(pkgDir, "package.json"), content, "utf8");
    } else {
      content = JSON.stringify({ name, version: "0.0.0" }, null, 2);
      fs.writeFileSync(path.join(pkgDir, "package.json"), content, "utf8");
    }
  }
  // create catalog path: @earendil-works/pi-ai/dist/providers/data/opencode-go.json
  const catalogDir = path.join(nmr, "@earendil-works/pi-ai/dist/providers/data");
  fs.mkdirSync(catalogDir, { recursive: true });
  const catalogPath = path.join(catalogDir, "opencode-go.json");
  if (!opts.noCatalog) {
    const catalog = opts.catalog ?? {
      [DESIRED_GROUP]: {
        "other-model": { id: "other-model", name: "Other", api: "openai-responses", provider: "opencode-go", baseUrl: "https://example.com" }
      },
      "other-group": {
        "foo": { id: "foo", name: "Foo" }
      }
    };
    if (opts.rawCatalog !== undefined) {
      fs.writeFileSync(catalogPath, opts.rawCatalog, "utf8");
    } else {
      fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
    }
  }
  return { nmr, catalogPath, catalogDir };
}

async function runTest(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

// ---- helpers for CLI JSON ----
function cli(args, opts = {}) {
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../scripts/patch-dsh-opencode-go-muse.mjs");
  const res = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", ...opts });
  return res;
}

// ---- Tests ----

await runTest("DESIRED_MODEL has exact thinkingLevelMap", async () => {
  const expected = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
  assertEqual(THINKING_LEVEL_MAP, expected, "THINKING_LEVEL_MAP must match spec");
  assertEqual(DESIRED_MODEL.thinkingLevelMap, expected, "DESIRED_MODEL.thinkingLevelMap must match spec");
  assert(!("thinkingLevelMap" in LEGACY_MODEL), "LEGACY_MODEL must not have thinkingLevelMap");
  // DESIRED_MODEL should equal LEGACY_MODEL plus thinkingLevelMap
  const { thinkingLevelMap, ...rest } = DESIRED_MODEL;
  assertEqual(rest, LEGACY_MODEL, "DESIRED_MODEL without map must equal LEGACY_MODEL");
});

await runTest("legacy entry check reports outdated not conflict", async () => {
  const root = createTempRoot();
  try {
    const { nmr, catalogPath } = makeFakeNodeModules(root, { catalog: { [DESIRED_GROUP]: { [DESIRED_KEY]: LEGACY_MODEL } } });
    const before = fs.readFileSync(catalogPath, "utf8");
    const result = await doCheck(nmr);
    assert(result.ok === false && result.outdated === true, "legacy check should be outdated non-ok");
    assert(result.legacy === true || result.reason === "outdated", "legacy flag");
    const after = fs.readFileSync(catalogPath, "utf8");
    assert(before === after, "legacy check must not mutate");
    let res = cli(["--check", "--node-modules-root", nmr, "--json"]);
    assert(res.status !== 0, "legacy CLI check should fail");
    const out = JSON.parse(res.stdout.trim().split("\n").pop());
    assert(out.ok === false && out.outdated === true, "legacy CLI json outdated");
  } finally { cleanTempRoot(root); }
});

await runTest("legacy migration via apply with backup/readback/idempotency", async () => {
  const root = createTempRoot();
  try {
    const rawLegacy = JSON.stringify({ [DESIRED_GROUP]: { [DESIRED_KEY]: LEGACY_MODEL } }, null, 2) + "\n";
    const { nmr, catalogPath } = makeFakeNodeModules(root, { catalog: { [DESIRED_GROUP]: { [DESIRED_KEY]: LEGACY_MODEL } } });
    const beforeRaw = fs.readFileSync(catalogPath, "utf8");
    assert(beforeRaw === rawLegacy, "raw legacy mismatch");
    const backupDir = path.join(root, "backup-legacy");
    fs.mkdirSync(backupDir);
    const result = await doApply(nmr, backupDir);
    assert(result.ok && !result.idempotent, "legacy apply should migrate");
    assert(result.backupFile, "backupFile present");
    assert(fs.readFileSync(result.backupFile, "utf8") === rawLegacy, "backup exact readback");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    assertEqual(catalog[DESIRED_GROUP][DESIRED_KEY], DESIRED_MODEL, "migrated entry exact");
    assertEqual(catalog[DESIRED_GROUP][DESIRED_KEY].thinkingLevelMap, THINKING_LEVEL_MAP, "migrated map exact");
    // check now ok
    const chk = await doCheck(nmr);
    assert(chk.ok === true, "check after migration ok");
    // idempotent second apply
    const r2 = await doApply(nmr, backupDir);
    assert(r2.idempotent === true && !r2.backupFile, "second apply idempotent");
    assert(fs.readdirSync(backupDir).length === 1, "no new backup on idempotent");
  } finally { cleanTempRoot(root); }
});

await runTest("arbitrary conflict still rejected (legacy-like tamper)", async () => {
  const root = createTempRoot();
  try {
    const tampered = { ...LEGACY_MODEL, name: "Tampered" };
    const { nmr } = makeFakeNodeModules(root, { catalog: { [DESIRED_GROUP]: { [DESIRED_KEY]: tampered } } });
    let threw = false;
    try { await doCheck(nmr); } catch (e) { threw = true; assert(e.message.includes("conflicting")); }
    assert(threw, "arbitrary tamper must still be conflicting");
    const backupDir = path.join(root, "backup-arb");
    fs.mkdirSync(backupDir);
    threw = false;
    try { await doApply(nmr, backupDir); } catch (e) { threw = true; }
    assert(threw, "arbitrary tamper apply must reject");
    // also thinkingLevelMap wrong value should be rejected
    const root2 = createTempRoot();
    try {
      const badMap = { ...DESIRED_MODEL, thinkingLevelMap: { ...THINKING_LEVEL_MAP, low: "wrong" } };
      const { nmr: nmr2 } = makeFakeNodeModules(root2, { catalog: { [DESIRED_GROUP]: { [DESIRED_KEY]: badMap } } });
      let threw2 = false;
      try { await doCheck(nmr2); } catch (e) { threw2 = true; }
      assert(threw2, "bad thinkingLevelMap must be rejected");
    } finally { cleanTempRoot(root2); }
  } finally { cleanTempRoot(root); }
});

await runTest("check no mutation", async () => {
  const root = createTempRoot();
  try {
    const { nmr, catalogPath } = makeFakeNodeModules(root);
    const before = fs.readFileSync(catalogPath, "utf8");
    const result = await doCheck(nmr);
    assert(result.missing === true && result.ok === false, "check should report missing");
    const after = fs.readFileSync(catalogPath, "utf8");
    assert(before === after, "check must not mutate file");
  } finally { cleanTempRoot(root); }
});

await runTest("apply exact DESIRED_MODEL", async () => {
  const root = createTempRoot();
  try {
    const { nmr, catalogPath } = makeFakeNodeModules(root);
    const backupDir = path.join(root, "backup");
    fs.mkdirSync(backupDir);
    const result = await doApply(nmr, backupDir);
    assert(result.ok && !result.idempotent, "apply should succeed non-idempotent");
    const raw = fs.readFileSync(catalogPath, "utf8");
    const catalog = JSON.parse(raw);
    const entry = catalog[DESIRED_GROUP]?.[DESIRED_KEY];
    assert(entry, "entry must exist after apply");
    assertEqual(entry, DESIRED_MODEL, "entry must exactly equal DESIRED_MODEL");
    assert(isPlainObject(entry), "entry must be plain object");
  } finally { cleanTempRoot(root); }
});

await runTest("preservation of unrelated groups and entries", async () => {
  const root = createTempRoot();
  try {
    const otherGroupData = { "keep-me": { id: "keep-me", name: "Keep" }, "also": { id: "also", foo: 123 } };
    const sameGroupOther = { "unrelated-model": { id: "unrelated-model", name: "Unrelated", api: "x", provider: "opencode-go" } };
    const initial = {
      [DESIRED_GROUP]: { ...sameGroupOther },
      "other-group": { ...otherGroupData },
      "another-group": { a: { id: "a" } }
    };
    const { nmr, catalogPath } = makeFakeNodeModules(root, { catalog: initial });
    const backupDir = path.join(root, "backup2");
    fs.mkdirSync(backupDir);
    await doApply(nmr, backupDir);
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    // unrelated groups preserved
    assertEqual(catalog["other-group"], otherGroupData, "other-group must be preserved");
    assertEqual(catalog["another-group"], { a: { id: "a" } }, "another-group preserved");
    assertEqual(catalog[DESIRED_GROUP]["unrelated-model"], sameGroupOther["unrelated-model"], "same-group unrelated entry preserved");
    assertEqual(catalog[DESIRED_GROUP][DESIRED_KEY], DESIRED_MODEL, "desired entry exact");
    // unrelated entries count
    assert(Object.keys(catalog[DESIRED_GROUP]).length === 2, "should have 2 entries in desired group");
  } finally { cleanTempRoot(root); }
});

await runTest("backup outside node_modules with exact original readback", async () => {
  const root = createTempRoot();
  try {
    const initial = {
      [DESIRED_GROUP]: { "x": { id: "x" } },
      "g": { y: { id: "y" } }
    };
    const rawBefore = JSON.stringify(initial, null, 2) + "\n";
    const { nmr, catalogPath } = makeFakeNodeModules(root, { catalog: initial });
    const beforeRead = fs.readFileSync(catalogPath, "utf8");
    assert(beforeRead === rawBefore, "setup raw mismatch");
    const backupDir = path.join(root, "my-backup");
    fs.mkdirSync(backupDir);
    const result = await doApply(nmr, backupDir);
    assert(result.backupFile, "backupFile should be returned");
    const rBackup = path.resolve(backupDir);
    const rNmr = path.resolve(nmr);
    const rBackupFile = path.resolve(result.backupFile);
    // backup outside node_modules
    assert(!rBackupFile.startsWith(rNmr + path.sep) && rBackupFile !== rNmr, "backup file must be outside node_modules");
    assert(rBackupFile.startsWith(rBackup + path.sep), "backup file must be inside backup dir");
    // backup not symlink
    const lst = fs.lstatSync(result.backupFile);
    assert(!lst.isSymbolicLink() && lst.isFile(), "backup must be regular file not symlink");
    const backupContent = fs.readFileSync(result.backupFile, "utf8");
    assert(backupContent === rawBefore, "backup must contain exact original readback");
    // also ensure target was updated
    const after = fs.readFileSync(catalogPath, "utf8");
    assert(after !== rawBefore, "catalog should change after apply");
  } finally { cleanTempRoot(root); }
});

await runTest("idempotent second apply with no new backup", async () => {
  const root = createTempRoot();
  try {
    const { nmr } = makeFakeNodeModules(root);
    const backupDir = path.join(root, "backup-idem");
    fs.mkdirSync(backupDir);
    const r1 = await doApply(nmr, backupDir);
    assert(!r1.idempotent, "first apply not idempotent");
    const filesAfterFirst = fs.readdirSync(backupDir);
    assert(filesAfterFirst.length === 1, "one backup after first apply");
    const r2 = await doApply(nmr, backupDir);
    assert(r2.idempotent === true, "second apply must be idempotent");
    assert(!r2.backupFile, "idempotent should not return backupFile");
    const filesAfterSecond = fs.readdirSync(backupDir);
    assert(filesAfterSecond.length === 1, "no new backup on second apply");
    // also check check reports ok after
    const chk = await doCheck(nmr);
    assert(chk.ok === true, "check should be ok after apply");
  } finally { cleanTempRoot(root); }
});

await runTest("rejection of wrong-group id", async () => {
  const root = createTempRoot();
  try {
    const initial = {
      [DESIRED_GROUP]: {},
      "wrong-group": { [DESIRED_KEY]: { ...DESIRED_MODEL } }
    };
    const { nmr } = makeFakeNodeModules(root, { catalog: initial });
    const backupDir = path.join(root, "backup-wrong");
    fs.mkdirSync(backupDir);
    let threw = false;
    try { await doCheck(nmr); } catch (e) { threw = true; assert(e.message.includes("conflicting"), "should mention conflicting"); }
    assert(threw, "doCheck must throw on wrong-group id");
    threw = false;
    try { await doApply(nmr, backupDir); } catch (e) { threw = true; }
    assert(threw, "doApply must throw on wrong-group id");
    // also test id-based conflict: entry in other group with id == DESIRED_KEY but different key
    const root2 = createTempRoot();
    try {
      const initial2 = {
        [DESIRED_GROUP]: {},
        "other": { "some-other-key": { id: DESIRED_KEY, name: "mismatch" } }
      };
      const { nmr: nmr2 } = makeFakeNodeModules(root2, { catalog: initial2 });
      let threw2 = false;
      try { await doCheck(nmr2); } catch (e) { threw2 = true; }
      assert(threw2, "should reject id match in wrong group");
    } finally { cleanTempRoot(root2); }
  } finally { cleanTempRoot(root); }
});

await runTest("rejection of conflicting metadata", async () => {
  const root = createTempRoot();
  try {
    const badEntry = { ...DESIRED_MODEL, name: "Tampered Name" };
    const initial = { [DESIRED_GROUP]: { [DESIRED_KEY]: badEntry } };
    const { nmr } = makeFakeNodeModules(root, { catalog: initial });
    const backupDir = path.join(root, "backup-conflict");
    fs.mkdirSync(backupDir);
    let threw = false;
    try { await doCheck(nmr); } catch (e) { threw = true; assert(e.message.includes("conflicting") || e.message.includes("fails closed"), "conflict message"); }
    assert(threw, "doCheck must throw on conflicting metadata");
    threw = false;
    try { await doApply(nmr, backupDir); } catch (e) { threw = true; }
    assert(threw, "doApply must throw on conflicting metadata");
  } finally { cleanTempRoot(root); }
});

await runTest("rejection of invalid package identity", async () => {
  const root = createTempRoot();
  try {
    const { nmr } = makeFakeNodeModules(root, { invalidPkg: "@earendil-works/pi-ai" });
    let threw = false;
    try { await doCheck(nmr); } catch (e) { threw = true; assert(e.message.includes("identity mismatch"), "should mention identity mismatch"); }
    assert(threw, "should reject invalid package identity");
    // also test invalid JSON package.json
    const root2 = createTempRoot();
    try {
      const { nmr: nmr2 } = makeFakeNodeModules(root2, { invalidPkgJsonContent: { "@deepseek-ai/dsh": "not json{" } });
      // Actually we pass raw string non-json
      fs.writeFileSync(path.join(nmr2, "@deepseek-ai/dsh/package.json"), "not json{", "utf8");
      let threw2 = false;
      try { await doCheck(nmr2); } catch (e) { threw2 = true; }
      assert(threw2, "should reject invalid package.json JSON");
    } finally { cleanTempRoot(root2); }
  } finally { cleanTempRoot(root); }
});

await runTest("rejection of target symlink", async () => {
  const root = createTempRoot();
  try {
    const { nmr, catalogPath, catalogDir } = makeFakeNodeModules(root);
    // replace target file with symlink
    const realPath = catalogPath + ".real";
    fs.renameSync(catalogPath, realPath);
    fs.symlinkSync(realPath, catalogPath);
    let threw = false;
    try { await doCheck(nmr); } catch (e) { threw = true; assert(e.message.includes("symlink"), "should mention symlink"); }
    assert(threw, "doCheck must reject target symlink");
    threw = false;
    const backupDir = path.join(root, "backup-sym");
    fs.mkdirSync(backupDir);
    try { await doApply(nmr, backupDir); } catch (e) { threw = true; }
    assert(threw, "doApply must reject target symlink");
    // cleanup symlink and restore for other symlink test
    fs.unlinkSync(catalogPath);
    fs.renameSync(realPath, catalogPath);
    // also test parent dir symlink: replace data dir with symlink
    const dataDir = catalogDir;
    const parent = path.dirname(dataDir);
    const dataReal = dataDir + ".real2";
    fs.renameSync(dataDir, dataReal);
    // move real content back via symlink
    fs.symlinkSync(dataReal, dataDir);
    threw = false;
    try { await doCheck(nmr); } catch (e) { threw = true; assert(e.message.includes("symlink"), "parent symlink should be rejected"); }
    assert(threw, "should reject catalog parent symlink");
    // restore
    fs.unlinkSync(dataDir);
    fs.renameSync(dataReal, dataDir);
  } finally { cleanTempRoot(root); }
});

await runTest("JSON CLI output", async () => {
  const root = createTempRoot();
  try {
    const { nmr } = makeFakeNodeModules(root);
    const backupDir = path.join(root, "backup-cli");
    fs.mkdirSync(backupDir);
    // check missing -> json should be valid and ok false
    let res = cli(["--check", "--node-modules-root", nmr, "--json"]);
    assert(res.status !== 0 || res.stdout.includes('"ok"'), "check json should output");
    let out = JSON.parse(res.stdout.trim().split("\n").pop());
    assert(out.ok === false && out.missing === true, "json check missing should have ok false missing true");
    // apply json
    res = cli(["--apply", "--node-modules-root", nmr, "--backup-dir", backupDir, "--json"]);
    assert(res.status === 0, `apply json should succeed: ${res.stderr} ${res.stdout}`);
    out = JSON.parse(res.stdout.trim().split("\n").pop());
    assert(out.ok === true && out.mode === "apply", "apply json ok true mode apply");
    assert(typeof out.backupFile === "string" && out.backupFile.length > 0, "backupFile present");
    // check present json
    res = cli(["--check", "--node-modules-root", nmr, "--json"]);
    assert(res.status === 0, "check after apply should exit 0");
    out = JSON.parse(res.stdout.trim().split("\n").pop());
    assert(out.ok === true && out.present === true, "check present ok true");
    // conflicting case json error shape
    const root2 = createTempRoot();
    try {
      const bad = { ...DESIRED_MODEL, name: "bad" };
      const { nmr: nmr2 } = makeFakeNodeModules(root2, { catalog: { [DESIRED_GROUP]: { [DESIRED_KEY]: bad } } });
      res = cli(["--check", "--node-modules-root", nmr2, "--json"]);
      assert(res.status !== 0, "conflicting check should fail");
      out = JSON.parse(res.stdout.trim().split("\n").pop());
      assert(out.ok === false && typeof out.error === "string", "error json shape");
    } finally { cleanTempRoot(root2); }
  } finally { cleanTempRoot(root); }
});

// ---- backup dir inside node_modules must be rejected ----
await runTest("backup dir inside node_modules rejected", async () => {
  const root = createTempRoot();
  try {
    const { nmr } = makeFakeNodeModules(root);
    const badBackup = path.join(nmr, "backup-inside");
    let threw = false;
    try { await doApply(nmr, badBackup); } catch (e) { threw = true; assert(e.message.includes("outside"), "should mention outside"); }
    assert(threw, "should reject backup inside node_modules");
  } finally { cleanTempRoot(root); }
});

await runTest("scope/package directory symlinks rejected", async () => {
  const root = createTempRoot();
  try {
    const { nmr } = makeFakeNodeModules(root);
    // symlink scope dir @deepseek-ai
    const scopePath = path.join(nmr, "@deepseek-ai");
    const realScope = scopePath + ".real";
    fs.renameSync(scopePath, realScope);
    fs.symlinkSync(realScope, scopePath);
    let threw = false;
    try { await doCheck(nmr); } catch (e) { threw = true; assert(e.message.includes("symlink"), "scope symlink"); }
    assert(threw, "should reject scope symlink");
    fs.unlinkSync(scopePath);
    fs.renameSync(realScope, scopePath);
    // symlink package dir @earendil-works/pi-ai
    const pkgPath = path.join(nmr, "@earendil-works/pi-ai");
    const realPkg = pkgPath + ".real";
    fs.renameSync(pkgPath, realPkg);
    fs.symlinkSync(realPkg, pkgPath);
    threw = false;
    try { await doCheck(nmr); } catch (e) { threw = true; assert(e.message.includes("symlink")); }
    assert(threw, "should reject package dir symlink");
    fs.unlinkSync(pkgPath);
    fs.renameSync(realPkg, pkgPath);
  } finally { cleanTempRoot(root); }
});

await runTest("primitive wrong-group and primitive correct-group conflicts", async () => {
  const root = createTempRoot();
  try {
    // primitive in wrong group with matching key
    const cat1 = { [DESIRED_GROUP]: {}, "other-group": { [DESIRED_KEY]: "primitive" } };
    const { nmr: nmr1 } = makeFakeNodeModules(root, { catalog: cat1 });
    let threw = false;
    try { await doCheck(nmr1); } catch (e) { threw = true; assert(e.message.includes("conflicting")); }
    assert(threw, "primitive wrong-group should fail");
    cleanTempRoot(root);
  } catch (e) { throw e; }
  const root2 = createTempRoot();
  try {
    const cat2 = { [DESIRED_GROUP]: { [DESIRED_KEY]: "primitive" } };
    const { nmr } = makeFakeNodeModules(root2, { catalog: cat2 });
    let threw = false;
    try { await doCheck(nmr); } catch (e) { threw = true; assert(e.message.includes("conflicting")); }
    assert(threw, "primitive correct-group should fail");
    const backupDir = path.join(root2, "backup-prim");
    fs.mkdirSync(backupDir);
    threw = false;
    try { await doApply(nmr, backupDir); } catch (e) { threw = true; }
    assert(threw, "apply with primitive correct-group should fail");
  } finally { cleanTempRoot(root2); }
  const root3 = createTempRoot();
  try {
    const cat3 = { [DESIRED_GROUP]: { [DESIRED_KEY]: 12345 } };
    const { nmr } = makeFakeNodeModules(root3, { catalog: cat3 });
    let threw = false;
    try { await doCheck(nmr); } catch (e) { threw = true; }
    assert(threw, "numeric primitive correct-group should fail");
  } finally { cleanTempRoot(root3); }
});

await runTest("nested backup creation", async () => {
  const root = createTempRoot();
  try {
    const { nmr } = makeFakeNodeModules(root);
    const nestedBackup = path.join(root, "a", "b", "c");
    // a exists, b/c missing
    fs.mkdirSync(path.join(root, "a"));
    const result = await doApply(nmr, nestedBackup);
    assert(result.ok, "nested backup apply should succeed");
    const lst = fs.lstatSync(nestedBackup);
    assert(lst.isDirectory() && !lst.isSymbolicLink(), "nested backup dir created");
    assert(fs.existsSync(result.backupFile), "backup file exists");
    // symlink inside backup chain should be rejected
    const root4 = createTempRoot();
    try {
      const { nmr: nmr4 } = makeFakeNodeModules(root4);
      const base = path.join(root4, "x");
      fs.mkdirSync(base);
      const linkTarget = path.join(root4, "real");
      fs.mkdirSync(linkTarget);
      const symlinkPath = path.join(base, "link");
      fs.symlinkSync(linkTarget, symlinkPath);
      const badNested = path.join(symlinkPath, "y");
      let threw = false;
      try { await doApply(nmr4, badNested); } catch (e) { threw = true; assert(e.message.includes("symlink")); }
      assert(threw, "symlink in backup chain should be rejected");
    } finally { cleanTempRoot(root4); }
  } finally { cleanTempRoot(root); }
});

await runTest("original mode preservation", async () => {
  const root = createTempRoot();
  try {
    const { nmr, catalogPath } = makeFakeNodeModules(root);
    fs.chmodSync(catalogPath, 0o600);
    const beforeMode = fs.statSync(catalogPath).mode & 0o777;
    const backupDir = path.join(root, "backup-mode");
    fs.mkdirSync(backupDir);
    await doApply(nmr, backupDir);
    const afterMode = fs.statSync(catalogPath).mode & 0o777;
    assert(beforeMode === 0o600, "before mode");
    assert(afterMode === beforeMode, `mode preserved: ${afterMode.toString(8)} vs ${beforeMode.toString(8)}`);
  } finally { cleanTempRoot(root); }
});

await runTest("conflicting mode arguments", async () => {
  const root = createTempRoot();
  try {
    const { nmr } = makeFakeNodeModules(root);
    const backupDir = path.join(root, "backup-conf");
    fs.mkdirSync(backupDir);
    let res = cli(["--check", "--apply", "--node-modules-root", nmr, "--backup-dir", backupDir]);
    assert(res.status !== 0, "conflicting check+apply should fail");
    assert(res.stderr.includes("conflicting") || res.stdout.includes("conflicting"), "should mention conflicting");
    res = cli(["--check", "--check", "--node-modules-root", nmr]);
    assert(res.status !== 0, "duplicate check should fail");
    res = cli(["--node-modules-root", nmr]);
    // missing value
    res = cli(["--node-modules-root"]);
    assert(res.status !== 0, "missing value should fail");
    res = cli(["--apply", "--node-modules-root", nmr, "--backup-dir"]);
    assert(res.status !== 0, "missing backup-dir value should fail");
  } finally { cleanTempRoot(root); }
});

// ---- summary ----
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) process.exit(1);
