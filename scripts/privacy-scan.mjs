#!/usr/bin/env node
/**
 * Scan repository text for accidental personal paths, addresses, or
 * credential-shaped values. Public OAuth client IDs are deliberately not a
 * finding: they are protocol identifiers, not user secrets.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ignoredDirectories = new Set(['.git', 'node_modules', 'coverage', 'dist', '.cache', '.tmp'])
const ignoredFiles = new Set([relative(root, fileURLToPath(import.meta.url))])
const textExtensions = new Set(['.cjs', '.d.ts', '.js', '.json', '.md', '.mjs', '.patch', '.ts', '.txt', '.yml', '.yaml'])

const personalPathPattern = new RegExp('/' + '(?:Users|home)' + '/[A-Za-z0-9._-]+')
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const tokenPattern = /(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{20,})/
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
const literalSecretPattern = /\b(?:access_token|refresh_token|id_token|api_key|client_secret)\s*[:=]\s*["'`](?!TEST_ONLY_|<|\$\{)[^"'`\n]{8,}/i
const allowedEmailDomains = new Set(['example.com', 'example.org', 'example.net', 'example.test'])

function collectFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(full))
    else if (entry.isFile() && textExtensions.has(extname(entry.name).toLowerCase())) files.push(full)
  }
  return files
}

function emailIsAllowed(value) {
  const domain = value.slice(value.lastIndexOf('@') + 1).toLowerCase()
  return allowedEmailDomains.has(domain)
}

const findings = []
for (const file of collectFiles(root)) {
  const rel = relative(root, file)
  if (ignoredFiles.has(rel)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (personalPathPattern.test(line)) findings.push(`${rel}:${index + 1}: personal path`)
    if (privateKeyPattern.test(line)) findings.push(`${rel}:${index + 1}: private key material`)
    if (tokenPattern.test(line)) findings.push(`${rel}:${index + 1}: token-shaped value`)
    if (literalSecretPattern.test(line)) findings.push(`${rel}:${index + 1}: literal credential value`)
    for (const match of line.matchAll(emailPattern)) {
      if (!emailIsAllowed(match[0])) findings.push(`${rel}:${index + 1}: non-fixture email address`)
    }
  }
}

if (findings.length > 0) {
  console.error('privacy scan failed:')
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log('privacy scan passed: no personal paths, non-fixture emails, private keys, or credential-shaped values found')
}
