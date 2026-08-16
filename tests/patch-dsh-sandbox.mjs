import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveSandboxPermission, SANDBOX_MODES, SANDBOX_MODE_RANK } from '../scripts/dsh-sandbox-compat.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const patchScript = join(root, 'scripts', 'patch-dsh-sandbox.mjs')
const patchFile = join(root, 'patches', 'dsh-sandbox-0.1.0-rc.6.patch')
const fixtureParent = mkdtempSync(join(root, '.tmp-rc6-'))

const buggy = [
  'function requestPermission(request) {',
  '\tconst { requestedMode: mode, effectiveMode, justification, subject } = request;',
  "\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to \"${mode}\" is not strictly wider than this call's current \"${effectiveMode}\" mode`);",
  '\treturn requestApproval({ mode, justification, subject });',
  '}',
  '',
].join('\n')

const guard = [
  '\tif ((mode === "read-only" || ESCALATION_TARGETS.includes(mode)) && (effectiveMode === "read-only" || ESCALATION_TARGETS.includes(effectiveMode)) && (mode === effectiveMode || (WIDER_MODES[mode] ?? []).includes(effectiveMode))) {',
  '\t\t// A globally advertised schema can redundantly request a no-op mode.',
  '\t\treturn effectiveMode;',
  '\t}',
].join('\n')

function run(args, expectedStatus = 0) {
  try {
    const stdout = execFileSync(process.execPath, [patchScript, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(expectedStatus, 0)
    return stdout
  } catch (error) {
    assert.equal(error?.status, expectedStatus, `unexpected helper status: ${error?.stderr ?? error}`)
    return `${error?.stdout ?? ''}${error?.stderr ?? ''}`
  }
}

function makeFixture(name, { name: packageName = '@deepseek-ai/dsh-sandbox', version = '0.1.0-rc.6', source = buggy } = {}) {
  const packageRoot = join(fixtureParent, name)
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, version }, null, 2) + '\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), source)
  return packageRoot
}

try {
  const patchText = readFileSync(patchFile, 'utf8')
  assert.match(patchText, /^diff --git a\/lib\/index\.js b\/lib\/index\.js/m)
  assert.ok(patchText.includes(guard.split('\n').map((line) => `+${line}`).join('\n')), 'patch file contains the actual rc.6 guard')
  assert.ok(!patchText.includes('requestedRank'), 'patch file does not contain fabricated source')

  const packageRoot = makeFixture('valid')
  const indexPath = join(packageRoot, 'lib', 'index.js')
  const backupPath = `${indexPath}.dsh-subscription-auth.rc6.bak`

  let output = run(['--package-root', packageRoot])
  assert.match(output, /no files changed/)
  assert.equal(readFileSync(indexPath, 'utf8'), buggy)
  assert.equal(existsSync(backupPath), false)

  output = run(['--package-root', packageRoot, '--apply'])
  assert.match(output, /applied rc\.6 compatibility patch/)
  const patched = readFileSync(indexPath, 'utf8')
  const expectedPatched = buggy.replace(
    '\tconst { requestedMode: mode, effectiveMode, justification, subject } = request;\n' +
      "\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to \"${mode}\" is not strictly wider than this call's current \"${effectiveMode}\" mode`);",
    '\tconst { requestedMode: mode, effectiveMode, justification, subject } = request;\n' + guard + '\n' +
      "\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to \"${mode}\" is not strictly wider than this call's current \"${effectiveMode}\" mode`);",
  )
  assert.equal(patched, expectedPatched, 'patched source is an exact guard insertion')
  assert.equal(readFileSync(backupPath, 'utf8'), buggy)

  output = run(['--package-root', packageRoot, '--apply'])
  assert.match(output, /already applied/)
  assert.equal(readFileSync(indexPath, 'utf8'), patched)
  assert.equal(readFileSync(backupPath, 'utf8'), buggy)

  output = run(['--package-root', packageRoot, '--check'])
  assert.match(output, /already applied/)

  // The compatibility model covers every recognized pair: only a strictly
  // wider request calls approval; equal or narrower requests are no-ops.
  for (const requestedMode of SANDBOX_MODES) {
    for (const effectiveMode of SANDBOX_MODES) {
      let approvals = 0
      const result = await resolveSandboxPermission(requestedMode, effectiveMode, async () => {
        approvals += 1
        return 'approved'
      })
      const wider = SANDBOX_MODE_RANK[requestedMode] > SANDBOX_MODE_RANK[effectiveMode]
      assert.equal(approvals, wider ? 1 : 0, `${requestedMode} over ${effectiveMode}`)
      assert.equal(result, wider ? 'approved' : effectiveMode, `${requestedMode} over ${effectiveMode} result`)
    }
  }
  await assert.rejects(resolveSandboxPermission('unknown', 'read-only', async () => 'bad'), /unknown sandbox mode/)

  const wrongVersion = makeFixture('wrong-version', { version: '0.1.0-rc.5' })
  assert.match(run(['--package-root', wrongVersion], 1), /expected @deepseek-ai\/dsh-sandbox@0\.1\.0-rc\.6/)
  const wrongName = makeFixture('wrong-name', { name: '@other/package' })
  assert.match(run(['--package-root', wrongName], 1), /expected @deepseek-ai\/dsh-sandbox@0\.1\.0-rc\.6/)
  const unknownSource = makeFixture('unknown-source', { source: buggy.replace('WIDER_MODES[effectiveMode]', 'UNKNOWN_MODES[effectiveMode]') })
  assert.match(run(['--package-root', unknownSource], 1), /unknown rc\.6 source/)

  const realRoot = makeFixture('symlink-target')
  const symlinkRoot = join(fixtureParent, 'symlink-root')
  symlinkSync(realRoot, symlinkRoot, 'dir')
  assert.match(run(['--package-root', symlinkRoot], 1), /package root must not be a symlink/)

  const symlinkIndexRoot = makeFixture('symlink-index')
  const indexTarget = join(fixtureParent, 'index-target.js')
  writeFileSync(indexTarget, buggy)
  rmSync(join(symlinkIndexRoot, 'lib', 'index.js'))
  symlinkSync(indexTarget, join(symlinkIndexRoot, 'lib', 'index.js'))
  assert.match(run(['--package-root', symlinkIndexRoot], 1), /lib\/index\.js must not be a symlink/)

  console.log('✓ dsh-sandbox rc.6 patch: exact source, check/apply/backup/idempotency, version/source/symlink guards, and complete mode matrix')
} finally {
  rmSync(fixtureParent, { recursive: true, force: true })
}
