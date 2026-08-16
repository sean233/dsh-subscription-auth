#!/usr/bin/env node
/**
 * Check or apply the narrowly scoped dsh-sandbox 0.1.0-rc.6 compatibility
 * patch. The package root is explicit and the only mutable file is
 * packageRoot/lib/index.js. Check is the default; mutation requires --apply.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const PACKAGE_NAME = '@deepseek-ai/dsh-sandbox'
const PACKAGE_VERSION = '0.1.0-rc.6'
const INDEX_RELATIVE_PATH = join('lib', 'index.js')

// This is the exact compiled rc.6 anchor. Do not replace it with a source
// approximation: a changed shape must fail closed for a reviewed update.
const SOURCE_ANCHOR = [
  '\tconst { requestedMode: mode, effectiveMode, justification, subject } = request;',
  "\tif (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to \"${mode}\" is not strictly wider than this call's current \"${effectiveMode}\" mode`);",
].join('\n')

const GUARD = [
  '\tif ((mode === "read-only" || ESCALATION_TARGETS.includes(mode)) && (effectiveMode === "read-only" || ESCALATION_TARGETS.includes(effectiveMode)) && (mode === effectiveMode || (WIDER_MODES[mode] ?? []).includes(effectiveMode))) {',
  '\t\t// A globally advertised schema can redundantly request a no-op mode.',
  '\t\treturn effectiveMode;',
  '\t}',
].join('\n')

const PATCHED_ANCHOR = [
  SOURCE_ANCHOR.split('\n')[0],
  GUARD,
  SOURCE_ANCHOR.split('\n')[1],
].join('\n')

function usage(message) {
  throw new Error(`${message}\nUsage: node scripts/patch-dsh-sandbox.mjs --package-root <path> [--check|--apply]`)
}

function parseArgs(argv) {
  let packageRoot
  let mode = 'check'
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--package-root') {
      packageRoot = argv[++index]
      if (!packageRoot || packageRoot.startsWith('--')) usage('--package-root needs a value')
    } else if (arg.startsWith('--package-root=')) {
      packageRoot = arg.slice('--package-root='.length)
      if (!packageRoot) usage('--package-root needs a value')
    } else if (arg === '--apply') {
      if (mode !== 'check') usage('choose exactly one of --check or --apply')
      mode = 'apply'
    } else if (arg === '--check') {
      if (mode !== 'check') usage('choose exactly one of --check or --apply')
      mode = 'check'
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/patch-dsh-sandbox.mjs --package-root <path> [--check|--apply]')
      process.exit(0)
    } else {
      usage(`unknown argument: ${arg}`)
    }
  }
  if (!packageRoot) usage('--package-root is required')
  return { packageRoot: resolve(packageRoot), mode }
}

function countOccurrences(text, fragment) {
  let count = 0
  let offset = 0
  while (true) {
    const found = text.indexOf(fragment, offset)
    if (found < 0) return count
    count += 1
    offset = found + fragment.length
  }
}

function requireRealDirectory(path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new Error(`${label} not found: ${path}`)
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`)
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`)
}

function requireRealFile(path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new Error(`${label} not found: ${path}`)
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`)
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
}

function readPackageMetadata(packageRoot) {
  const packageJson = join(packageRoot, 'package.json')
  requireRealFile(packageJson, 'package.json')
  let metadata
  try {
    metadata = JSON.parse(readFileSync(packageJson, 'utf8'))
  } catch (error) {
    throw new Error(`invalid package.json: ${error instanceof Error ? error.message : 'parse failed'}`)
  }
  if (metadata?.name !== PACKAGE_NAME || metadata?.version !== PACKAGE_VERSION) {
    throw new Error(`refusing package ${String(metadata?.name)}@${String(metadata?.version)}; expected ${PACKAGE_NAME}@${PACKAGE_VERSION}`)
  }
}

function locateIndex(packageRoot) {
  requireRealDirectory(join(packageRoot, 'lib'), 'lib')
  const indexPath = join(packageRoot, INDEX_RELATIVE_PATH)
  requireRealFile(indexPath, INDEX_RELATIVE_PATH)
  return indexPath
}

function locateState(indexPath) {
  const source = readFileSync(indexPath, 'utf8')
  const buggyCount = countOccurrences(source, SOURCE_ANCHOR)
  const fixedCount = countOccurrences(source, PATCHED_ANCHOR)
  if (buggyCount === 1 && fixedCount === 0) return { state: 'buggy', source }
  if (buggyCount === 0 && fixedCount === 1) return { state: 'fixed', source }
  if (buggyCount === 0 && fixedCount === 0) {
    throw new Error('unknown rc.6 source: exact lib/index.js anchor was not found')
  }
  throw new Error('ambiguous rc.6 source: expected exactly one unpatched or patched anchor')
}

function backupPath(indexPath) {
  return `${indexPath}.dsh-subscription-auth.rc6.bak`
}

function ensureBackup(indexPath, original) {
  const backup = backupPath(indexPath)
  if (existsSync(backup)) {
    requireRealFile(backup, 'rc.6 backup')
    if (readFileSync(backup, 'utf8') !== original) {
      throw new Error(`refusing to overwrite a non-matching backup: ${backup}`)
    }
    return backup
  }
  copyFileSync(indexPath, backup)
  if (readFileSync(backup, 'utf8') !== original) {
    throw new Error(`backup readback failed: ${backup}`)
  }
  return backup
}

function applyPatch(indexPath, source) {
  const backup = ensureBackup(indexPath, source)
  const patched = source.replace(SOURCE_ANCHOR, PATCHED_ANCHOR)
  if (patched === source || countOccurrences(patched, SOURCE_ANCHOR) !== 0 || countOccurrences(patched, PATCHED_ANCHOR) !== 1) {
    throw new Error('exact replacement did not produce the expected patched source')
  }
  writeFileSync(indexPath, patched, 'utf8')
  const readback = readFileSync(indexPath, 'utf8')
  if (readback !== patched) throw new Error('patched source exact readback failed')
  console.log(`applied rc.6 compatibility patch: ${indexPath}`)
  console.log(`backup: ${backup}`)
}

function main() {
  const { packageRoot, mode } = parseArgs(process.argv.slice(2))
  requireRealDirectory(packageRoot, 'package root')
  readPackageMetadata(packageRoot)
  const indexPath = locateIndex(packageRoot)
  const state = locateState(indexPath)
  if (state.state === 'fixed') {
    console.log(`rc.6 compatibility patch already applied: ${indexPath}`)
    return
  }
  if (mode === 'check') {
    console.log(`rc.6 compatibility patch available; no files changed: ${indexPath}`)
    return
  }
  applyPatch(indexPath, state.source)
}

try {
  main()
} catch (error) {
  console.error(`patch-dsh-sandbox: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
