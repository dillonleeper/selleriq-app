// Fails the build if any tracked source file contains CP1252 mojibake.
//
// app/profitability/page.tsx has been corrupted twice (9e58003, b4fc831) by a save path
// that reads the file as CP1252 and writes it back as UTF-8. Each round trip turns one
// non-ASCII character into two or three, so a SKU/ASIN separator that should read
// "SKU <middot> ASIN" ships as "SKU <A-circumflex><middot> ASIN". The glyphs look
// plausible in an editor, which is why it kept reaching production unnoticed.
//
// lib/displayText.ts is the fix: typographic characters live there as \uXXXX escapes,
// which are plain ASCII bytes and survive the round trip unchanged. This script is what
// keeps that discipline enforced.
//
// Like lib/displayText.ts, this file intentionally contains NO non-ASCII characters --
// every mojibake sequence below is written as an escape. Keep it that way: a literal
// glyph here would make the linter flag itself and fail the build.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.json', '.md', '.sql', '.html', '.txt',
])

// CP1252 renderings of UTF-8 lead bytes C2 / C3 / E2, plus EF (a double-encoded BOM).
// Deliberately narrow: broadening this to every Latin-1 lead byte would flag legitimate
// accented prose (e.g. French a-grave followed by a non-breaking space).
const LEAD = '[\u00C2\u00C3\u00E2\u00EF]'

// CP1252 renderings of UTF-8 continuation bytes 0x80-0xBF. Bytes 0x80-0x9F map into the
// CP1252 punctuation block, with 0x81/0x8D/0x8F/0x90/0x9D undefined and passed through
// as-is; bytes 0xA0-0xBF map to U+00A0-U+00BF unchanged.
const CONT = '['
  + '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F'
  + '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178'
  + '\u00A0-\u00BF'
  + ']'

const MOJIBAKE = new RegExp(LEAD + CONT + '+', 'g')

// A single backslash, built from its code point. Written this way because a literal
// backslash-u in this file is itself vulnerable to being rewritten by tooling.
const BS = String.fromCharCode(92)

// Known sequences -> the character they should have been, and how to write it safely.
const HINTS = new Map([
  ['\u00C2\u00B7', 'U+00B7 middle dot -- use MIDDOT from lib/displayText.ts'],
  ['\u00E2\u20AC\u201D', 'U+2014 em dash -- use EM_DASH from lib/displayText.ts'],
  ['\u00E2\u02C6\u2019', 'U+2212 minus sign -- use MINUS from lib/displayText.ts'],
  ['\u00E2\u20AC\u00A6', 'U+2026 ellipsis -- use ELLIPSIS from lib/displayText.ts'],
  ['\u00E2\u20AC\u2122', 'U+2019 right single quote -- use a plain apostrophe, or write it as an escape'],
  ['\u00E2\u20AC\u0153', 'U+201C left double quote -- write it as an escape'],
  ['\u00E2\u20AC\u009D', 'U+201D right double quote -- write it as an escape'],
  ['\u00E2\u20AC\u201C', 'U+2013 en dash -- write it as an escape'],
  ['\u00C2\u00A0', 'U+00A0 non-breaking space -- use a plain space instead'],
  ['\u00EF\u00BB\u00BF', 'UTF-8 byte order mark, double-encoded'],
])

function esc(seq) {
  return [...seq]
    .map(c => BS + 'u' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
    .join('')
}

function describe(seq) {
  const hint = HINTS.get(seq)
  return hint ? hint + ' (found ' + esc(seq) + ')' : 'unrecognized mojibake ' + esc(seq)
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

const files = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean)
  .filter(f => EXTENSIONS.has(path.extname(f).toLowerCase()))

const findings = []

for (const file of files) {
  let text
  try {
    text = readFileSync(path.join(root, file), 'utf8')
  } catch {
    continue // unreadable or binary; not our concern
  }
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(MOJIBAKE)) {
      findings.push({ file, line: i + 1, col: m.index + 1, seq: m[0] })
    }
  })
}

if (findings.length === 0) {
  console.log('lint:encoding -- ' + files.length + ' tracked files scanned, no mojibake found')
  process.exit(0)
}

console.error('lint:encoding -- ' + findings.length + ' mojibake sequence(s) in ' + files.length + ' tracked files:\n')
for (const f of findings) {
  console.error('  ' + f.file + ':' + f.line + ':' + f.col)
  console.error('    ' + describe(f.seq))
}
console.error(`
This file was re-encoded as CP1252 somewhere in its save path. Do not just retype the
glyph -- it regressed that way twice already. Import the constant from lib/displayText.ts
instead, so the source bytes stay pure ASCII.
`)
process.exit(1)
