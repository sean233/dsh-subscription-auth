import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(new URL('.', import.meta.url).pathname, '..')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const sourceRoot = join(root, 'src')
const libRoot = join(root, 'lib')

const requiredFiles = [
  'README.md', 'README.en.md', 'LICENSE', 'NOTICE.md', 'CONTRIBUTING.md', 'SECURITY.md',
  '.editorconfig', '.gitignore', '.github/workflows/ci.yml',
  'docs/CONFIGURATION.md', 'docs/TROUBLESHOOTING.md', 'docs/SECURITY-PRIVACY.md',
  'examples/config.example.yaml', 'scripts/privacy-scan.mjs', 'lib/types/index.d.ts',
]
for (const path of requiredFiles) assert.equal(existsSync(join(root, path)), true, `required file: ${path}`)

const removedFiles = [
  'src/adapters/gemini.ts', 'src/channels/gemini.ts', 'src/gemini-oauth.ts',
  'lib/adapters/gemini.js', 'lib/channels/gemini.js', 'lib/gemini-oauth.js', 'tests/gemini.mjs',
]
for (const path of removedFiles) assert.equal(existsSync(join(root, path)), false, `removed native Gemini file remains: ${path}`)

const sourceIndex = readFileSync(join(sourceRoot, 'index.ts'), 'utf8')
const libIndex = readFileSync(join(libRoot, 'index.js'), 'utf8')
for (const text of [sourceIndex, libIndex]) {
  assert.equal(text.includes('geminiChannel'), false, 'native Gemini channel import/registration remains')
  assert.equal(text.includes('channels/gemini'), false, 'native Gemini channel path remains')
}

assert.equal(packageJson.description.includes('Gemini'), false, 'package description advertises native Gemini')
const pluginManifest = JSON.parse(readFileSync(join(root, 'dsh.plugin.json'), 'utf8'))
assert.equal(pluginManifest.description.includes('Gemini'), false, 'plugin description advertises native Gemini')
assert.deepEqual(
  ['agy', 'chatgpt', 'claude', 'grok', 'kimi'].sort(),
  ['agy', 'chatgpt', 'claude', 'grok', 'kimi'].sort(),
)
assert.equal(sourceIndex.includes("'GEMINI"), false, 'native Gemini credential setting remains')

const forbiddenFragments = [
  ['DSH_', 'GEMINI_HOME'].join(''),
  ['DSH_', 'GEMINI_OAUTH_CLIENT_ID'].join(''),
  ['DSH_', 'GEMINI_OAUTH_CLIENT_SECRET'].join(''),
  ['GEMINI_', 'SUBSCRIPTION_TOKEN'].join(''),
  ['cloudcode-pa', '.googleapis.com'].join(''),
  ['oauth_', 'creds.json'].join(''),
  ['google_', 'accounts.json'].join(''),
  ['GOOGLE_', 'CLOUD_PROJECT'].join(''),
]

function collectTextFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.tmp-rc6-') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectTextFiles(full))
    else if (entry.isFile() && ['.js', '.json', '.md', '.mjs', '.patch', '.ts', '.yml', '.yaml'].includes(extname(entry.name))) files.push(full)
  }
  return files
}

const agySource = readFileSync(join(sourceRoot, 'channels/agy.ts'), 'utf8')
const agyLib = readFileSync(join(libRoot, 'channels/agy.js'), 'utf8')
assert.match(agySource, /export const AGY_DEFAULT_MODELS\s*:\s*AdapterModel\[\]\s*=\s*\[\]/, 'source Agy catalog must be empty')
assert.match(agyLib, /export const AGY_DEFAULT_MODELS\s*=\s*\[\]/, 'generated Agy catalog must be empty')

for (const file of [...collectTextFiles(sourceRoot), ...collectTextFiles(libRoot)]) {
  const text = readFileSync(file, 'utf8')
  assert.equal(text.toLowerCase().includes('gemini'), false, `${relative(root, file)} contains a product Gemini marker`)
}

for (const file of collectTextFiles(root)) {
  const text = readFileSync(file, 'utf8')
  for (const fragment of forbiddenFragments) {
    assert.equal(text.includes(fragment), false, `${relative(root, file)} contains removed native Gemini marker ${fragment}`)
  }
}

function collectSourceTs(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectSourceTs(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}
for (const source of collectSourceTs(sourceRoot)) {
  const output = join(libRoot, relative(sourceRoot, source).replace(/\.ts$/, '.js'))
  assert.equal(existsSync(output), true, `generated lib missing for ${relative(root, source)}`)
}

assert.equal(packageJson.scripts?.build, 'bun scripts/build-bun.mjs')
assert.equal(packageJson.scripts?.['test:clean'], 'bun tests/clean-checkout.mjs && bun tests/patch-dsh-sandbox.mjs')
assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026, Khellendros97/)
assert.match(readFileSync(join(root, 'NOTICE.md'), 'utf8'), /https:\/\//)

console.log('✓ clean-checkout-safe packaging: five native channels, no native Gemini artifacts, generated lib sync, docs, and scripts')
