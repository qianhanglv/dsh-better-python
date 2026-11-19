import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'index.js'), 'utf8')
const probeFile = join(here, '.plug-under-test.mjs')
writeFileSync(probeFile, `${source}\nexport { parseCommand, segments, requirementName, normalisePackages, validSourceUrl, probeInterpreter, validateExtraArgs, resolveEditables };\n`)
const { parseCommand, requirementName, normalisePackages, validSourceUrl, probeInterpreter, validateExtraArgs, resolveEditables } = await import(probeFile)
unlinkSync(probeFile)

const cases = [
  ['python3 -m pip install numpy', { verb: 'install', packages: ['numpy'] }],
  ['python3 -m pip install matplotlib 2>&1 | tail -5', { verb: 'install', packages: ['matplotlib'] }],
  ['pip install "requests[socks]>=2.31"', { verb: 'install', packages: ['requests'] }],
  ['pip3 install -r requirements.txt', { verb: 'install', packages: [], requirementFile: 'requirements.txt' }],
  ['/Users/x/.venv/bin/pip install numpy', { verb: 'install', packages: ['numpy'], isolated: true }],
  ['sudo pip install numpy', { verb: 'install', packages: ['numpy'], elevated: true }],
  ['python -m pip uninstall torch', { verb: 'uninstall', packages: ['torch'] }],
  ['pip install --upgrade numpy', { verb: 'install', packages: ['numpy'], forced: true }],
  ['uv pip install ruff', { verb: 'install', packages: ['ruff'] }],
  ['pip install --user numpy', { verb: 'install', packages: ['numpy'], user: true }],
  ['pip install --target ./vendor numpy', { verb: 'install', packages: ['numpy'], isolated: true }],
  ['pip install --dry-run numpy', { verb: 'install', packages: ['numpy'], inert: true }],
  ['pip install -e .', { verb: 'install', packages: [], editable: true }],
  ['cd /tmp && python3 -m pip install numpy && echo done', { verb: 'install', packages: ['numpy'] }],
]

let failed = 0
for (const [command, expected] of cases) {
  const actual = parseCommand(command)
  let ok = actual !== null
  if (ok) for (const [key, value] of Object.entries(expected)) {
    const got = actual[key]
    if (JSON.stringify(got) !== JSON.stringify(value)) { ok = false; console.log(`   ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`) }
  }
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${command}`)
}

const nulls = ['echo hi', 'ls 2> /dev/null', 'python3 script.py', 'pip list', 'pip install', 'node -e "x"']
for (const command of nulls) {
  const actual = parseCommand(command)
  const ok = actual === null
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  (no intent) ${command} -> ${actual === null ? 'null' : JSON.stringify(actual)}`)
}

const names = [['requests[socks]>=2.31', 'requests'], ['PIL', 'PIL'], ['python-docx==1.2.0', 'python-docx'], ['numpy', 'numpy']]
for (const [input, expected] of names) {
  const actual = requirementName(input)
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  requirementName(${input}) = ${actual}`)
}

const packageCases = [
  [['numpy', 'pandas>=2', 'numpy', 'bad name', 'uvicorn[standard]'], ['numpy', 'pandas', 'uvicorn']],
  [[], []],
  [[42, null, 'ok'], ['ok']],
]
for (const [input, expected] of packageCases) {
  const actual = normalisePackages(input).map(item => item.name)
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  normalisePackages(${JSON.stringify(input)}) = ${JSON.stringify(actual)}`)
}

const urlCases = [
  ['https://mirrors.aliyun.com/pypi/simple/', true],
  ['http://mirror.local/simple', true],
  ['ftp://mirror.local/simple', false],
  ['not a url', false],
  ['', false],
]
for (const [input, accepted] of urlCases) {
  const actual = validSourceUrl(input)
  const ok = accepted ? actual !== null : actual === null
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  validSourceUrl(${JSON.stringify(input)}) = ${actual}`)
}

const PYTHON = '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13'
const firstProbe = await probeInterpreter(PYTHON, ['tabulate'], undefined)
const secondProbe = await probeInterpreter(PYTHON, ['tabulate'], undefined)
const freshProbe = await probeInterpreter(PYTHON, ['tabulate'], undefined, { fresh: true })
const cached = firstProbe === secondProbe
const bypassed = freshProbe !== firstProbe
if (!cached) failed += 1
if (!bypassed) failed += 1
console.log(`${cached ? 'PASS' : 'FAIL'}  probe cache reuses the first result`)
console.log(`${bypassed ? 'PASS' : 'FAIL'}  probe fresh:true bypasses the cache (${JSON.stringify(freshProbe.packages[0])})`)

// --- extraArgs allowlist ---
const extraOk = [
  [[], []],
  [['--no-deps', '--upgrade', '--no-deps'], ['--no-deps', '--upgrade']],
  [['--no-build-isolation'], ['--no-build-isolation']],
]
for (const [input, expected] of extraOk) {
  const actual = validateExtraArgs(input)
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  validateExtraArgs(${JSON.stringify(input)}) = ${JSON.stringify(actual)}`)
}
if (validateExtraArgs(undefined).length !== 0) { failed += 1; console.log('FAIL  validateExtraArgs(undefined)') } else { console.log('PASS  validateExtraArgs(undefined) = []') }

for (const bad of [['--index-url'], ['-i'], ['--user'], ['--target=./x'], ['--break-system-packages'], [''], ['--no-deps', 'numpy']]) {
  let threw = false
  try { validateExtraArgs(bad) } catch { threw = true }
  if (!threw) failed += 1
  console.log(`${threw ? 'PASS' : 'FAIL'}  validateExtraArgs refuses ${JSON.stringify(bad)}`)
}

// --- editable project validation ---
const root = mkdtempSync(join(tmpdir(), 'pyg-edit-'))
mkdirSync(join(root, 'proj'))
writeFileSync(join(root, 'proj', 'pyproject.toml'), '[project]\nname = "x"\nversion = "0.0.1"\n')
writeFileSync(join(root, 'plain.txt'), 'x')

const good = await resolveEditables(['proj'], root)
const goodOk = good.length === 1 && good[0] === join(root, 'proj')
if (!goodOk) failed += 1
console.log(`${goodOk ? 'PASS' : 'FAIL'}  resolveEditables accepts a project dir -> ${JSON.stringify(good)}`)

for (const [label, input, base] of [
  ['missing path', ['nope'], root],
  ['dir without markers', ['.'], root],
  ['a file, not a dir', ['plain.txt'], root],
  ['non-array', 'proj', root],
]) {
  let threw = false
  try { await resolveEditables(input, base) } catch { threw = true }
  if (!threw) failed += 1
  console.log(`${threw ? 'PASS' : 'FAIL'}  resolveEditables refuses ${label}`)
}
rmSync(root, { recursive: true, force: true })

// --- user-allowlisted flags and the hard ban ---
const asConfig = flags => ({ extraFlags: flags })

let accepted = null
try { accepted = validateExtraArgs(['--only-binary'], asConfig('--only-binary=:all:')) } catch {}
const acceptedOk = JSON.stringify(accepted) === '["--only-binary"]'
if (!acceptedOk) failed += 1
console.log(`${acceptedOk ? 'PASS' : 'FAIL'}  user-allowlisted flag is accepted -> ${JSON.stringify(accepted)}`)

let withValue = null
try { withValue = validateExtraArgs(['--only-binary=:all:'], asConfig('--only-binary')) } catch {}
const withValueOk = JSON.stringify(withValue) === '["--only-binary=:all:"]'
if (!withValueOk) failed += 1
console.log(`${withValueOk ? 'PASS' : 'FAIL'}  inline value keeps its flag name -> ${JSON.stringify(withValue)}`)

let banMessage = ''
try { validateExtraArgs(['--index-url'], asConfig('--index-url')) } catch (error) { banMessage = error.message }
const banned = banMessage.includes('cannot be allowlisted')
if (!banned) failed += 1
console.log(`${banned ? 'PASS' : 'FAIL'}  hard-banned flag survives a user allowlist entry`)

let unknownMessage = ''
try { validateExtraArgs(['--only-binary'], { extraFlags: '' }) } catch (error) { unknownMessage = error.message }
const guides = unknownMessage.includes('额外的 pip 参数') && unknownMessage.includes('do not work around')
if (!guides) failed += 1
console.log(`${guides ? 'PASS' : 'FAIL'}  unknown flag names the settings path and forbids a workaround`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
