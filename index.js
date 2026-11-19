/**
 * Python environment guard — probe before installing, and prefer the libraries
 * that already exist on this machine.
 *
 * Host-only DSH bundle plugin. It deliberately imports nothing from DSH
 * packages: the tool is registered in the registry's raw `ToolDefinition`
 * shape, so a DSH upgrade changes the plugin's surroundings, not its load.
 *
 * Three contributions:
 *   1. `python_env` tool — read-only probing of every plausible interpreter, plus
 *      optional creation of a workspace virtual environment that reuses the
 *      user's existing libraries.
 *   2. A system-prompt section stating the preference order.
 *   3. A `tools/pre-execute` gate on package installs, so a redundant install is
 *      refused and a missing package becomes the user's decision.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin identity. */
export const name = 'python-env-guard'

/** Services this plugin needs before it can activate. */
export const inject = ['tools', 'systemPrompt', 'userQuestions']

/** Tools whose shell commands the install gate inspects. */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal'])

/** Interpreters beyond this count are not probed. */
const MAX_INTERPRETERS = 8

/** One probe subprocess budget. */
const PROBE_TIMEOUT_MS = 12_000

/** Probe results are reused for this long so a gate and a tool call cost one run. */
const PROBE_TTL_MS = 30_000

/** Workspace virtual environment created on request. */
const DEFAULT_VENV_DIR = '.dsh-venv'

/** Install sources offered in the confirmation dialog and in the plugin settings. */
const SOURCES = [
  { id: 'default', label: '默认源（不指定）', url: null, description: 'PyPI 官方渠道：不加 -i 参数' },
  { id: 'tuna', label: '清华 TUNA', url: 'https://pypi.tuna.tsinghua.edu.cn/simple', description: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { id: 'aliyun', label: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple/', description: 'https://mirrors.aliyun.com/pypi/simple/' },
  { id: 'ustc', label: '中科大 USTC', url: 'https://pypi.mirrors.ustc.edu.cn/simple/', description: 'https://pypi.mirrors.ustc.edu.cn/simple/' },
  { id: 'tencent', label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/pypi/simple', description: 'https://mirrors.cloud.tencent.com/pypi/simple' },
  { id: 'douban', label: '豆瓣', url: 'https://pypi.douban.com/simple/', description: 'https://pypi.douban.com/simple/' },
]

/** Answer label that aborts an install. */
const CANCEL_LABEL = '取消安装'

/** Answer labels for the uninstall confirmation. */
const CONFIRM_UNINSTALL_LABEL = '确认卸载'
const CANCEL_UNINSTALL_LABEL = '保留，不卸载'

/**
 * Extra pip flags every caller may use. The user may allowlist more in the
 * plugin settings; the model cannot, so the permission surface stays something
 * a person wrote down.
 */
const BUILTIN_EXTRA_FLAGS = [
  '--no-deps',
  '--pre',
  '--upgrade',
  '--force-reinstall',
  '--ignore-installed',
  '--no-build-isolation',
  '--no-cache-dir',
  '--prefer-binary',
  '--no-warn-script-location',
  '--use-pep517',
]

/**
 * Flags that change where packages come from or where they land. They are
 * refused for every caller, including a user-allowlisted one, because the
 * confirmation dialog promises one source and one target interpreter.
 */
const HARD_BANNED_FLAGS = new Set([
  '-i', '--index-url', '--extra-index-url', '--trusted-host', '--no-index',
  '-f', '--find-links', '-r', '--requirement', '-c', '--constraint',
  '-t', '--target', '--prefix', '--root', '--user', '--src',
  '-e', '--editable', '--break-system-packages',
])

/**
 * Flag names the user allowlisted in the plugin settings, on top of the built-in
 * list. Only the user edits this list; the model can read it, never extend it.
 * @param config - the row's resolved config.
 * @returns Every flag name a call may use.
 */
function allowedExtraFlags(config = liveConfig) {
  const allowed = new Set(BUILTIN_EXTRA_FLAGS)
  const raw = settingValue(config, 'extraFlags', '')
  for (const token of raw.split(/[\s,]+/u)) {
    const name = flagName(token.trim())
    if (name.length > 0 && !HARD_BANNED_FLAGS.has(name)) allowed.add(name)
  }
  return allowed
}

/**
 * Strip a flag's inline value, so `--only-binary=:all:` is judged by its name.
 * @param token - a flag token.
 * @returns The flag name.
 */
function flagName(token) {
  const index = token.indexOf('=')
  return index === -1 ? token : token.slice(0, index)
}

/** Display title used in guidance text; keep in sync with `meta.title` in locale/zh.json. */
const DISPLAY_TITLE = '更省心的 Python 安装'

/** Files that mark a directory as an installable Python project. */
const PROJECT_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg']

/** Arguments `python_install` understands; anything else is a caller mistake worth naming. */
const INSTALL_ARGUMENTS = ['action', 'packages', 'editable', 'extraArgs', 'interpreter', 'workspace']

/** The row's resolved config, kept so helpers can read the live default source. */
let liveConfig

/** Budget for one install; large wheels on a slow mirror need room. */
const INSTALL_TIMEOUT_MS = 900_000

/**
 * Editable settings. Volatile fields update in place, so the Plugins page can
 * change the default source without restarting the plugin, and `apply` reads
 * the live value on every use.
 */
export const Config = z.object({
  sourceId: z.string().default('default').volatile(),
  customUrl: z.string().default('').volatile(),
  extraFlags: z.string().default('').volatile(),
})

/**
 * Read a setting whether the loader handed us a live volatile reference or a
 * plain value.
 * @param config - the row's resolved config.
 * @param key - field name.
 * @param fallback - value used when the field is absent.
 * @returns The current string value.
 */
function settingValue(config, key, fallback) {
  const field = config?.[key]
  if (typeof field === 'string') return field
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    const current = field.get()
    if (typeof current === 'string') return current
  }
  return fallback
}

/**
 * Resolve the configured default source.
 * @param config - the row's resolved config; omitted reads the last applied one.
 * @returns The source row, falling back to the unconfigured default.
 */
function defaultSource(config = liveConfig) {
  const sourceId = settingValue(config, 'sourceId', 'default')
  if (sourceId === 'custom') {
    const url = validSourceUrl(settingValue(config, 'customUrl', ''))
    if (url !== null) return { id: 'custom', label: '自定义镜像', url, description: url }
  }
  return SOURCES.find(source => source.id === sourceId) ?? SOURCES[0]
}

/**
 * Accept only an http(s) mirror URL; pip would otherwise treat the value as a
 * path or a malformed index.
 * @param value - candidate URL.
 * @returns The normalized URL, or null.
 */
function validSourceUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Python entry names, by platform. */
const PYTHON_NAMES = process.platform === 'win32' ? ['python.exe'] : ['python3', 'python']
const VENV_BIN = process.platform === 'win32' ? 'Scripts' : 'bin'
const VENV_PYTHON = process.platform === 'win32' ? 'python.exe' : 'python3'

/**
 * Emitted by the probe subprocess so stray warnings on stdout cannot corrupt the
 * result.
 */
const PROBE_MARKER = '@@PYTHON-ENV-GUARD@@'

/**
 * Runs inside the probed interpreter. Receives the requested names as one JSON
 * argument and prints one marked JSON line: interpreter identity, its
 * site-packages directories, and per-name importability and version.
 *
 * Distribution names differ from import names often enough that the alias table
 * matters: `PIL` is distributed as `Pillow`, `docx` as `python-docx`.
 */
const PROBE_SCRIPT = String.raw`
import json, sys

MARKS = {
    "pil": "Pillow", "docx": "python-docx", "pptx": "python-pptx",
    "sklearn": "scikit-learn", "skimage": "scikit-image", "cv2": "opencv-python",
    "yaml": "PyYAML", "xlsxwriter": "XlsxWriter", "dateutil": "python-dateutil",
    "bs4": "beautifulsoup4", "attr": "attrs", "jwt": "PyJWT", "usb": "pyusb",
    "serial": "pyserial", "Crypto": "pycryptodome", "OpenGL": "PyOpenGL",
    "magic": "python-magic", "mysql": "mysql-connector-python", "dotenv": "python-dotenv",
    "fitz": "PyMuPDF", "win32api": "pywin32", "pkg_resources": "setuptools",
}

names = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
try:
    import importlib.util
    import importlib.metadata as metadata
except Exception:
    importlib = None
    metadata = None

def lookup(name):
    found = False
    try:
        found = importlib.util.find_spec(name) is not None
    except Exception:
        found = False
    dist = MARKS.get(name, MARKS.get(name.lower(), name))
    version = None
    if metadata is not None:
        for candidate in (dist, name):
            try:
                version = metadata.version(candidate)
                break
            except Exception:
                version = None
    if version is None and found:
        try:
            module = __import__(name)
            value = getattr(module, "__version__", None)
            version = value if isinstance(value, str) else None
        except Exception:
            version = None
    return {"name": name, "importable": bool(found), "dist": dist, "version": version}

result = {
    "executable": sys.executable,
    "version": "%d.%d.%d" % sys.version_info[:3],
    "prefix": sys.prefix,
    "basePrefix": getattr(sys, "base_prefix", sys.prefix),
    "isVenv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
    "sitePackages": [p for p in sys.path if p.endswith("site-packages")],
    "packages": [lookup(n) for n in names],
}
sys.stdout.write("\n@@PYTHON-ENV-GUARD@@" + json.dumps(result) + "\n")
`

/** Prompt section text; the whole point of the plugin. */
const POLICY = `## Python environments and dependencies

Before writing or running Python, call \`python_env\` to see which interpreters exist and what they already provide. Installing a package is the last resort, never the first move.

Preference order:

1. An interpreter that already has every required library. Use it, and name it in your reply.
2. A workspace virtual environment from \`python_env\` \`action: "create_venv"\`, which reuses existing libraries through \`--system-site-packages\` unless the user wants isolation.
3. Installing into the user's own environment, only after the user chooses it.

A missing library is the user's decision, not a purchase you make: ask whether to install into their existing environment or to run in a virtual environment, and state which interpreter you will use and roughly how much will be added. Never upgrade, downgrade, uninstall, or add packages in the user's environment on your own judgement.`

/**
 * Split a shell command into argument lists at `&&`, `||`, `;`, `|`, and
 * newlines, honouring quotes, so one segment's flags do not leak into another.
 * @param command - raw shell command.
 * @returns Token arrays, one per segment.
 */
function segments(command) {
  const parts = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote !== null) {
      if (char === quote) { quote = null; continue }
      if (char === '\\' && quote === '"' && index + 1 < command.length) { current += command[index + 1]; index += 1; continue }
      current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '>' || char === '<') {
      // A redirection ends the argument list; the file-descriptor digit before
      // it belongs to the redirection, not to the command.
      parts.push(current.replace(/\s*\d+$/u, ''))
      current = ''
      continue
    }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      parts.push(current)
      current = ''
      if ((char === '|' || char === '&') && command[index + 1] === char) index += 1
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
    .map(part => part.trim().split(/\s+/u).filter(Boolean))
    .filter(tokens => tokens.length > 0)
}

/** Pip flags that consume the following token as a value. */
const VALUE_FLAGS = new Set([
  '-r', '--requirement', '-c', '--constraint', '-i', '--index-url', '--extra-index-url',
  '-f', '--find-links', '-e', '--editable', '-t', '--target', '--prefix', '--root',
  '--upgrade-strategy', '--only-binary', '--no-binary', '--platform', '--python-version',
  '--implementation', '--abi', '--src', '--progress-bar', '--log', '--timeout', '--retries',
  '--cache-dir', '--proxy', '--cert', '--client-cert', '--global-option', '--config-settings',
])

/** Flags that mean the call is not writing to the environment it resolves. */
const INERT_FLAGS = new Set(['--dry-run', '--help', '-h', '--version'])

/** Flags that mean the user asked for a deliberate change rather than a fill-in. */
const FORCE_FLAGS = new Set(['--upgrade', '-U', '--force-reinstall', '--ignore-installed', '--upgrade-strategy'])

/**
 * Reduce a pip requirement to the importable name used for probing.
 * @param token - requirement token such as `requests[socks]>=2.31`.
 * @returns The bare distribution or import name.
 */
function requirementName(token) {
  return token.split(/[<>=!~@[\]]/u)[0].trim()
}

/**
 * Recognise a package-management call inside one tokenized segment.
 * @param tokens - one shell segment's arguments.
 * @returns Install intent, or null when the segment is not a package call.
 */
function parseSegment(tokens) {
  let index = 0
  let elevated = false
  while (index < tokens.length && (tokens[index] === 'sudo' || tokens[index] === 'doas')) {
    elevated = true
    index += 1
  }
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index])) index += 1
  const rest = tokens.slice(index)
  if (rest.length === 0) return null

  let verb = null
  let interpreter = null
  let pipPath = undefined
  let packageIndex = -1
  let implicit = true

  const pipLike = (token) => /^pip(3(\.[0-9]+)?)?$/u.test(token)
  const pythonLike = (token) => /(^|\/)(python[0-9.]*|py)$/u.test(token)

  if (rest[0] === 'uv' && rest[1] === 'pip') {
    verb = rest[2]
    packageIndex = 3
  } else if (pythonLike(rest[0]) && rest[1] === '-m' && pipLike(rest[2])) {
    interpreter = rest[0]
    verb = rest[3]
    packageIndex = 4
  } else if (pipLike(rest[0])) {
    pipPath = rest[0]
    verb = rest[1]
    packageIndex = 2
  } else if (/\/pip(3(\.[0-9]+)?)?$/u.test(rest[0])) {
    pipPath = rest[0]
    interpreter = null
    verb = rest[1]
    packageIndex = 2
    implicit = false
  } else {
    return null
  }

  if (verb !== 'install' && verb !== 'uninstall' && verb !== 'download') return null
  if (verb === 'download') return null

  const packages = []
  const flags = new Set()
  let requirementFile = null
  let isolated = false
  for (let cursor = packageIndex; cursor < rest.length; cursor += 1) {
    const token = rest[cursor]
    if (token.startsWith('-')) {
      const [flag] = token.split('=')
      flags.add(flag)
      if (flag === '-r' || flag === '--requirement') {
        requirementFile = token.includes('=') ? token.slice(token.indexOf('=') + 1) : rest[cursor + 1] ?? null
      }
      if (flag === '--target' || flag === '--prefix' || flag === '--root') isolated = true
      if (token.includes('=')) continue
      if (VALUE_FLAGS.has(flag)) cursor += 1
      continue
    }
    const bare = requirementName(token)
    if (bare.length > 0) packages.push(bare)
  }

  const joined = rest.join(' ')
  const inVenv = /(^|[\s/])(\.dsh-venv|\.venv|venv|env)\/(bin|Scripts)\//u.test(joined)
    || /(^|[\s/])(\.dsh-venv|\.venv|venv|env)\\Scripts\\/u.test(joined)
  const userFlag = flags.has('--user')
  const editable = flags.has('-e') || flags.has('--editable')

  if (packages.length === 0 && requirementFile === null && !editable) return null

  return {
    verb,
    packages,
    flags,
    requirementFile,
    editable,
    elevated,
    implicit,
    interpreter,
    pipPath,
    isolated: isolated || inVenv,
    user: userFlag,
    inert: [...flags].some(flag => INERT_FLAGS.has(flag)),
    forced: [...flags].some(flag => FORCE_FLAGS.has(flag)),
  }
}

/**
 * Inspect a shell command for a package-management call.
 * @param command - raw command text.
 * @returns The first recognised intent, or null.
 */
function parseCommand(command) {
  for (const tokens of segments(command)) {
    const parsed = parseSegment(tokens)
    if (parsed !== null) return parsed
  }
  return null
}

/**
 * Pick the command string out of the arguments of a shell tool.
 * @param toolName - tool being called.
 * @param args - parsed call arguments.
 * @returns The command, when the tool runs a shell.
 */
function shellCommand(toolName, args) {
  if (!SHELL_TOOLS.has(toolName) || args === null || typeof args !== 'object') return undefined
  const value = args.command ?? args.script
  return typeof value === 'string' ? value : undefined
}

/** Interpreters already resolved, keyed by real path. */
const resolutionCache = new Map()

/** Probe results keyed by interpreter plus requested names. */
const probeCache = new Map()

/**
 * Locate an executable on PATH the way a shell would, without spawning one.
 * @param names - candidate file names.
 * @returns Absolute path of the first match, if any.
 */
function searchPath(names) {
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const directory of directories) {
    for (const candidate of names) {
      const full = join(directory, candidate)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

/**
 * Read the interpreter that a pip console script belongs to, so a bare `pip`
 * call is judged against the environment it actually writes.
 * @param pipPath - resolved pip executable.
 * @returns The interpreter its shebang names, when it is a script.
 */
async function interpreterFromPip(pipPath) {
  try {
    const [first] = (await readFile(pipPath, 'utf8')).split('\n', 1)
    const match = /^#!\s*(\S+)/u.exec(first)
    if (match === null) return undefined
    return await realInterpreter(match[1])
  } catch {
    return undefined
  }
}

/**
 * Resolve the workspace a call concerns: the explicit argument, then the
 * calling session's directory, then the Host process directory.
 * @param requested - explicit workspace argument.
 * @param agent - calling agent, when a model invoked the tool.
 * @returns Absolute workspace directory.
 */
function workspaceOf(requested, agent) {
  if (typeof requested === 'string' && requested.length > 0) return resolve(requested)
  try {
    const cwd = agent?.session?.meta?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return resolve(cwd)
  } catch { /* an agent without session metadata falls back to the Host directory */ }
  return resolve(process.cwd())
}

/**
 * Resolve a path to its real identity so aliases and symlinks probe once.
 * @param path - candidate interpreter.
 * @returns Real path, or undefined when the file does not exist.
 */
async function realInterpreter(path) {
  if (resolutionCache.has(path)) return resolutionCache.get(path)
  let real
  try {
    real = await realpath(path)
  } catch {
    resolutionCache.set(path, undefined)
    return undefined
  }
  resolutionCache.set(path, real)
  return real
}

/**
 * Collect the interpreters worth probing, most specific first.
 * @param workspace - workspace directory whose virtual environments come first.
 * @returns Deduplicated absolute interpreter paths.
 */
async function discoverInterpreters(workspace) {
  const found = []
  const push = async (candidate) => {
    const real = await realInterpreter(candidate)
    if (real !== undefined && !found.includes(real) && found.length < MAX_INTERPRETERS) found.push(real)
  }

  if (process.env.VIRTUAL_ENV) await push(join(process.env.VIRTUAL_ENV, VENV_BIN, VENV_PYTHON))
  for (const dir of [DEFAULT_VENV_DIR, '.venv', 'venv', 'env']) await push(join(workspace, dir, VENV_BIN, VENV_PYTHON))

  if (process.env.PATH) {
    for (const name of PYTHON_NAMES) {
      const hit = searchPath([name])
      if (hit !== undefined) await push(hit)
    }
  }

  try {
    const root = join(homedir(), '.dsh', 'dsh-runtimes')
    for (const entry of await readdir(root)) await push(join(root, entry, 'dependencies', 'python', VENV_BIN, VENV_PYTHON))
  } catch { /* no bundled runtime is a normal layout */ }

  await push('/usr/bin/python3')
  return found
}

/**
 * Run one interruptible subprocess.
 * @param executable - interpreter to run.
 * @param args - interpreter arguments.
 * @param signal - caller cancellation, forwarded to the child.
 * @param timeout - enforced budget in milliseconds.
 * @returns Captured stdout.
 */
function run(executable, args, signal, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((settle, reject) => {
    execFile(executable, args, {
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONWARNINGS: 'ignore',
        MPLCONFIGDIR: join(tmpdir(), 'dsh-better-python'),
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { capturedStderr: typeof stderr === 'string' ? stderr.slice(-800) : '' }))
        return
      }
      settle(stdout)
    })
  })
}

/**
 * Ask one interpreter what it provides.
 * @param executable - interpreter path.
 * @param packages - import or distribution names.
 * @param signal - caller cancellation.
 * @param options - `fresh` bypasses the cache, for a re-probe after an install.
 * @returns Interpreter identity plus one entry per requested name.
 */
async function probeInterpreter(executable, packages, signal, options = {}) {
  const key = `${executable}::${[...packages].sort().join(',')}`
  const cached = probeCache.get(key)
  if (options.fresh !== true && cached !== undefined && Date.now() - cached.at < PROBE_TTL_MS) return cached.value

  let value
  try {
    const stdout = await run(executable, ['-c', PROBE_SCRIPT, JSON.stringify(packages)], signal)
    const line = stdout.split('\n').find(entry => entry.startsWith(PROBE_MARKER))
    if (line === undefined) throw new Error('probe returned no result')
    value = JSON.parse(line.slice(PROBE_MARKER.length))
  } catch (error) {
    if (signal?.aborted) throw error
    value = { executable, error: error instanceof Error ? error.message : String(error), packages: [], sitePackages: [] }
  }
  probeCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * Probe several interpreters in parallel, bounded by the discovery list.
 * @param interpreteters - interpreter paths.
 * @param packages - requested names.
 * @param signal - caller cancellation.
 * @returns One result per interpreter, in the given order.
 */
async function probeAll(interpreters, packages, signal) {
  return Promise.all(interpreters.map(executable => probeInterpreter(executable, packages, signal)))
}

/**
 * Decide what a probe result means for the caller.
 * @param results - per-interpreter probe results.
 * @param packages - requested names.
 * @returns The interpreters that satisfy every name and the names nobody has.
 */
function summarise(results, packages) {
  const usable = results.filter(result => result.error === undefined)
  const satisfied = (result) => result.packages.filter(entry => provides(entry)).length
  const complete = usable.filter(result => satisfied(result) === packages.length && packages.length > 0)
  const missingEverywhere = packages.filter(name => !usable.some(result => result.packages.some(entry => entry.name === name && provides(entry))))
  return { complete, missingEverywhere }
}

/**
 * Render one probe result as a compact line.
 * @param result - interpreter probe result.
 * @param packages - requested names.
 * @returns Human-readable summary.
 */
function describe(result, packages) {
  if (result.error !== undefined) return `${result.executable} — unavailable (${result.error})`
  const parts = result.packages.map(entry => entry.importable ? `${entry.name} ${entry.version ?? '(version unknown)'}` : `${entry.name} —`)
  const kind = result.isVenv ? 'venv' : 'base'
  return `${result.executable} — Python ${result.version} (${kind}) — ${parts.join(', ')}${packages.length === 0 ? 'no packages requested' : ''}`
}

/**
 * Register the probe tool, the policy section, the install gate, and the guard.
 * @param ctx - plugin context.
 * @param config - the row's resolved settings.
 */
export function apply(ctx, config) {
  liveConfig = config
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'policy:python-environment',
    order: (() => {
      try {
        return ctx.systemPrompt.getSectionOrder('TOOL_BASH') - 50
      } catch {
        return 950
      }
    })(),
    text: POLICY,
  }))

  ctx.tools.register({
    name: 'python_env',
    description: 'Probe the Python interpreters on this machine and report which already provide specific packages. Read-only, and cheap: call it before writing or running Python, and always before installing anything. When every requested package is present somewhere, use that interpreter instead of installing. When something is missing everywhere, ask the user to choose between their own environment and a workspace virtual environment (action "create_venv"), then proceed with their choice. It never installs, upgrades, or removes packages.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['probe', 'create_venv'],
          description: 'Defaults to "probe". "create_venv" creates the workspace virtual environment and returns its interpreter.',
        },
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Python import names or distribution names to check, such as "numpy", "PIL", "python-docx".',
        },
        workspace: {
          type: 'string',
          description: 'Workspace directory whose virtual environments and default venv path are used. Defaults to the session workspace.',
        },
        interpreter: {
          type: 'string',
          description: 'Probe only this interpreter, or the base interpreter used to create the environment.',
        },
        systemSitePackages: {
          type: 'boolean',
          description: 'For "create_venv": let the environment reuse installed libraries. Defaults to true.',
        },
        venvPath: {
          type: 'string',
          description: `For "create_venv": where to create it. Defaults to <workspace>/${DEFAULT_VENV_DIR}.`,
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    isConcurrencySafe: (args) => args?.action !== 'create_venv',
    execute: async (args, exec) => {
      const workspace = workspaceOf(args?.workspace, exec.agent)
      const packages = Array.isArray(args?.packages)
        ? args.packages.filter(entry => typeof entry === 'string' && entry.trim().length > 0).map(entry => entry.trim())
        : []

      if (args?.action === 'create_venv') {
        const target = typeof args?.venvPath === 'string' && args.venvPath.length > 0
          ? resolve(args.venvPath)
          : join(workspace, DEFAULT_VENV_DIR)
        const base = typeof args?.interpreter === 'string' && isAbsolute(args.interpreter)
          ? args.interpreter
          : await discoverInterpreters(workspace).then(list => list[0])
        if (base === undefined) throw new Error('no Python interpreter found to create the environment')
        const reuse = args?.systemSitePackages !== false
        await mkdir(workspace, { recursive: true })
        await run(base, ['-m', 'venv', ...(reuse ? ['--system-site-packages'] : []), target], exec.signal, 120_000)
        const created = join(target, VENV_BIN, VENV_PYTHON)
        const probe = await probeInterpreter(created, packages, exec.signal)
        return {
          action: 'create_venv',
          workspace,
          venvPath: target,
          interpreter: created,
          systemSitePackages: reuse,
          version: probe.version ?? null,
          packages: probe.packages,
          missing: probe.packages.filter(entry => !entry.importable).map(entry => entry.name),
        }
      }

      const candidates = typeof args?.interpreter === 'string' && args.interpreter.length > 0
        ? [resolve(args.interpreter)]
        : await discoverInterpreters(workspace)
      if (candidates.length === 0) throw new Error('no Python interpreter found')
      const results = await probeAll(candidates, packages, exec.signal)
      const { complete, missingEverywhere } = summarise(results, packages)
      return {
        action: 'probe',
        workspace,
        requested: packages,
        interpreters: results,
        servedBy: complete.map(result => result.executable),
        recommended: complete[0]?.executable ?? results.find(result => result.error === undefined)?.executable ?? null,
        missingEverywhere,
      }
    },
  })

  ctx.tools.register({
    name: 'python_install',
    description: 'Install Python packages only after the user confirms, from an install source the user picks. It probes first: when every package is already importable it installs nothing and reports the existing versions. Otherwise it shows one confirmation dialog listing the packages, the target interpreter and the available mirror sources, then installs with the chosen source. Use action "uninstall" to remove packages: it shows one confirmation dialog naming what is installed and where, and removes only after the user agrees. Raw pip commands are refused, so this tool is the only supported path. Call it once with every package instead of once per package.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['install', 'uninstall'],
          description: 'Defaults to "install". "uninstall" removes packages after one confirmation dialog.',
        },
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Distribution names, such as "numpy" or "python-docx". Version specifiers are allowed.',
        },
        editable: {
          type: 'array',
          items: { type: 'string' },
          description: 'Local project directories to install in editable mode (-e), each holding pyproject.toml, setup.py, or setup.cfg. Relative paths resolve against the workspace.',
        },
        extraArgs: {
          type: 'array',
          items: { type: 'string' },
          description: `Extra pip flags. Built in: ${BUILTIN_EXTRA_FLAGS.join(', ')}; the user may allowlist more in the plugin settings. Flags that change the install source or target are always refused.`,
        },
        interpreter: {
          type: 'string',
          description: 'Target interpreter path. When omitted, the discovered interpreter that already provides the most packages is used.',
        },
        workspace: {
          type: 'string',
          description: 'Workspace used to discover interpreters and virtual environments. Defaults to the session workspace.',
        },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: renderValue(value) }] },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      for (const key of Object.keys(args ?? {})) {
        if (INSTALL_ARGUMENTS.includes(key)) continue
        throw new Error(`python_install got unknown argument ${JSON.stringify(key)}; it accepts ${INSTALL_ARGUMENTS.join(', ')}`)
      }
      const workspace = workspaceOf(args?.workspace, exec.agent)
      const requested = normalisePackages(args?.packages)
      const editables = await resolveEditables(args?.editable, workspace)
      const extras = validateExtraArgs(args?.extraArgs)
      const unpacking = args?.action === 'uninstall'
      if (requested.length === 0 && !(editables.length > 0 && !unpacking)) {
        throw new Error(unpacking
          ? 'python_install with action "uninstall" needs at least one package name'
          : 'python_install needs at least one package, or one editable project directory')
      }
      if (unpacking && editables.length > 0) throw new Error('python_install cannot uninstall an editable project directory; name its distribution instead')
      const names = requested.map(item => item.name)

      let probe
      if (typeof args?.interpreter === 'string' && args.interpreter.length > 0) {
        const explicit = isAbsolute(args.interpreter) ? args.interpreter : searchPath([args.interpreter]) ?? args.interpreter
        probe = await probeInterpreter(explicit, names, exec.signal)
      } else {
        const candidates = await discoverInterpreters(workspace)
        if (candidates.length === 0) throw new Error('no Python interpreter found')
        const results = await probeAll(candidates, names, exec.signal)
        const usable = results.filter(result => result.error === undefined)
        const { complete } = summarise(results, names)
        const best = complete[0] ?? [...usable].sort((left, right) => provided(right) - provided(left))[0] ?? results[0]
        probe = best
      }
      if (probe.executable === undefined) throw new Error('no usable Python interpreter found')

      const interpreter = probe.executable
      const base = { packages: probe.packages, interpreter, version: probe.version ?? null, source: defaultSource() }

      if (args?.action === 'uninstall') {
        const installed = probe.packages.filter(entry => provides(entry))
        if (installed.length === 0) return { ...base, status: 'nothing-to-remove', output: '' }
        const agreed = await askUninstall(ctx, exec, { installed, interpreter, version: probe.version ?? null })
        if (!agreed) return { ...base, status: 'cancelled', output: '用户选择保留，未做任何改动' }
        const dists = installed.map(entry => entry.dist ?? entry.name)
        const removal = await runCapture(interpreter, ['-m', 'pip', 'uninstall', '-y', ...dists], exec.signal)
        const removalOutput = tail(`${removal.stdout}\n${removal.stderr}`.trim(), 3000)
        if (removal.code !== 0) return { ...base, status: 'failed', output: removalOutput }
        const remaining = await probeInterpreter(interpreter, names, exec.signal, { fresh: true })
        return { ...base, status: 'uninstalled', packages: remaining.packages, version: remaining.version ?? null, output: removalOutput }
      }

      const missing = probe.packages.filter(entry => !provides(entry)).map(entry => entry.name)
      if (missing.length === 0 && editables.length === 0) return { ...base, status: 'already-present', output: '' }

      const present = probe.packages.filter(entry => provides(entry)).map(entry => `${entry.name} ${entry.version ?? '?'}`)
      const choice = await askInstallSource(ctx, exec, {
        missing, present, interpreter, version: probe.version ?? null, editables, extras,
      })
      if (choice.kind !== 'source') {
        return { ...base, status: choice.kind, output: choice.reason ?? '' }
      }

      const specs = requested.filter(item => missing.includes(item.name)).map(item => item.spec)
      const result = await installPackages(interpreter, specs, editables, extras, choice.source, exec.signal)
      const output = tail(`${result.stdout}\n${result.stderr}`.trim(), 3000)
      if (result.code !== 0) return { ...base, status: 'failed', source: choice.source, output }
      const after = names.length === 0
        ? { packages: [], version: probe.version ?? null }
        : await probeInterpreter(interpreter, names, exec.signal, { fresh: true })
      return {
        ...base,
        status: 'installed',
        source: choice.source,
        packages: after.packages,
        version: after.version ?? null,
        editables,
        extras,
        output,
      }
    },
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const command = shellCommand(exec.name, exec.arguments)
    if (command === undefined) return next()
    const intent = parseCommand(command)
    if (intent === null || intent.inert) return next()

    const workspace = workspaceOf(exec.arguments?.workdir, exec.agent)
    const named = intent.packages.length > 0
      ? intent.packages.join(', ')
      : intent.requirementFile !== null
        ? `from ${intent.requirementFile}`
        : 'a local project'

    if (intent.verb === 'uninstall') {
      return {
        kind: 'deny',
        reason: `Removing ${named} requires the user's explicit confirmation, which a shell command cannot obtain. Call python_install with action "uninstall" and those packages: it shows one confirmation dialog naming what is installed and where, and removes them only after the user agrees. Do not retry this shell command.`,
        info: { name: 'PYTHON_UNINSTALL_NEEDS_CONSENT', code: 'PY_UNINSTALL_NEEDS_CONSENT' },
      }
    }

    const interpreter = await resolveInterpreter(intent, workspace)
    if (intent.packages.length > 0 && interpreter !== undefined) {
      const probe = await probeInterpreter(interpreter, intent.packages, exec.signal)
      if (probe.error === undefined) {
        const present = probe.packages.filter(entry => provides(entry) && entry.version !== null)
        if (!intent.forced && present.length === intent.packages.length) {
          const detail = present.map(entry => `${entry.name} ${entry.version}`).join(', ')
          return {
            kind: 'deny',
            reason: `Already installed in ${interpreter}: ${detail}. Import them instead of installing; the interpreter is ready to use. Do not reach the same effect through another entry point or by editing the environment by hand. If a different version is genuinely required, say why and let the user decide.`,
            info: { name: 'PYTHON_DEPENDENCY_PRESENT', code: 'PY_ALREADY_INSTALLED', reason: detail },
          }
        }
      }
    }

    return {
      kind: 'deny',
      reason: `Installing packages runs only through the python_install tool, which shows the user one confirmation dialog with the target interpreter and the install sources. Call python_install once with all of: ${named}. This refusal is deliberate: do not reach the same effect through a different entry point, a script, or a generated helper, and do not retry this command. If the tool cannot express what the task needs, say so to the user and let them decide.`,
      info: { name: 'PYTHON_INSTALL_NEEDS_CONFIRMATION', code: 'PY_INSTALL_NEEDS_CONFIRMATION' },
    }
  })

  ctx.tools.guard((exec) => {
    const command = shellCommand(exec.name, exec.arguments)
    if (command === undefined) return undefined
    const intent = parseCommand(command)
    if (intent === null || intent.inert || intent.verb === 'uninstall') return undefined
    if (intent.elevated) {
      return {
        reason: 'Installing Python packages with elevated privileges is never allowed. Use the existing interpreter, a workspace virtual environment, or the user\'s own environment with their explicit approval.',
        info: { name: 'PYTHON_ELEVATED_INSTALL', code: 'PY_ELEVATED_INSTALL' },
      }
    }
    return undefined
  })
}

/**
 * Whether an interpreter already provides a package. Distribution metadata is
 * authoritative: a hyphenated distribution may install an underscored module,
 * so a failed import of the literal name proves nothing.
 * @param entry - one probe entry.
 * @returns True when the distribution or the module is present.
 */
function provides(entry) {
  return entry.version !== null || entry.importable === true
}

/** Count how many of the requested packages one interpreter already provides. */
function provided(result) {
  return result.packages.filter(entry => provides(entry)).length
}

/**
 * Normalize requested package specs, keeping both the install spec and the bare
 * import name used for probing.
 * @param value - raw `packages` argument.
 * @returns One entry per distinct distribution name.
 */
function normalisePackages(value) {
  const out = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== 'string') continue
    const spec = entry.trim()
    if (spec.length === 0 || /[\s;|&`$(){}"']/u.test(spec)) continue
    const name = requirementName(spec)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) continue
    if (!out.some(item => item.name === name)) out.push({ name, spec })
  }
  return out
}

/**
 * Resolve the interpreter a shell install command targets.
 * @param intent - parsed package intent.
 * @param workspace - workspace whose virtual environments are searched last.
 * @returns Absolute interpreter path, when one is found.
 */
async function resolveInterpreter(intent, workspace) {
  let interpreter
  if (intent.interpreter !== null) {
    interpreter = await realInterpreter(
      isAbsolute(intent.interpreter) ? intent.interpreter : searchPath([intent.interpreter]),
    )
  } else if (intent.pipPath !== undefined) {
    const pip = searchPath([intent.pipPath]) ?? intent.pipPath
    const resolved = await realInterpreter(pip)
    interpreter = await interpreterFromPip(resolved ?? pip)
  }
  return interpreter ?? (await discoverInterpreters(workspace))[0]
}

/**
 * Ask the user to confirm one batch install and pick its source. A single
 * dialog covers every package in the call.
 * @param ctx - plugin context carrying the question service.
 * @param exec - the tool execution, supplying the agent and cancellation.
 * @param details - packages, target interpreter, and what is already present.
 * @returns The chosen source, or the reason nothing was installed.
 */
async function askInstallSource(ctx, exec, details) {
  const configured = defaultSource()
  const options = SOURCES.map(source => ({
    label: source.label,
    description: source.url ?? '不指定镜像，使用 pip 默认渠道',
  }))
  options.push({ label: CANCEL_LABEL, description: '这次不安装任何包' })

  const detail = [
    `目标解释器：${details.interpreter}${details.version === null ? '' : ` (Python ${details.version})`}`,
    details.missing.length > 0 ? `需要安装：${details.missing.join(', ')}` : '需要安装：无（只做可编辑安装）',
    details.editables.length > 0 ? `可编辑安装：${details.editables.join('，')}` : null,
    details.extras.length > 0 ? `附加参数：${details.extras.join(' ')}` : null,
    details.present.length === 0 ? null : `已存在：${details.present.join(', ')}`,
    `当前默认源：${configured.label}${configured.url === null ? '' : ` — ${configured.url}`}`,
    '要使用自定义镜像，直接在回答框里填写镜像站 URL，会覆盖上面的选择。',
  ].filter(line => line !== null).join('\n')

  const subject = details.missing.length > 0
    ? details.missing.join(', ')
    : details.editables.map(path => path.split('/').pop()).join(', ')

  let answer
  try {
    const result = await ctx.userQuestions.ask({
      questions: [{
        id: 'python-install-source',
        header: 'Python 安装确认',
        question: `确认安装 ${subject}？请选择安装源`,
        detail,
        options,
        multiSelect: false,
      }],
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      signal: exec.signal,
    })
    answer = result.answers[0]
  } catch (error) {
    return { kind: 'unavailable', reason: `确认对话框不可用：${error instanceof Error ? error.message : String(error)}` }
  }

  if (answer === undefined) return { kind: 'cancelled', reason: '没有收到回答，未安装任何包' }
  const custom = validSourceUrl(answer.custom)
  if (custom !== null) return { kind: 'source', source: { id: 'custom', label: '自定义镜像', url: custom, description: custom } }
  const [selected] = answer.selected
  if (selected === undefined || selected === CANCEL_LABEL) return { kind: 'cancelled', reason: '用户取消了安装' }
  const picked = SOURCES.find(source => source.label === selected)
  if (picked === undefined) return { kind: 'cancelled', reason: `无法识别的安装源：${selected}` }
  return { kind: 'source', source: picked }
}

/**
 * Ask the user to confirm one batch uninstall. A single dialog covers every
 * package in the call.
 * @param ctx - plugin context carrying the question service.
 * @param exec - the tool execution, supplying the agent and cancellation.
 * @param details - installed packages and their interpreter.
 * @returns Whether the user confirmed removal.
 */
async function askUninstall(ctx, exec, details) {
  const detail = [
    `目标解释器：${details.interpreter}${details.version === null ? '' : ` (Python ${details.version})`}`,
    `当前已安装：${details.installed.map(entry => `${entry.name} ${entry.version ?? '?'}`).join(', ')}`,
    '卸载后不会自动恢复，需要时得重新安装。',
  ].join('\n')

  let answer
  try {
    const result = await ctx.userQuestions.ask({
      questions: [{
        id: 'python-uninstall',
        header: 'Python 卸载确认',
        question: `确认卸载 ${details.installed.map(entry => entry.name).join(', ')}？`,
        detail,
        options: [
          { label: CONFIRM_UNINSTALL_LABEL, description: '从上面这个解释器里移除' },
          { label: CANCEL_UNINSTALL_LABEL, description: '什么都不做' },
        ],
        multiSelect: false,
      }],
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      signal: exec.signal,
    })
    answer = result.answers[0]
  } catch (error) {
    throw new Error(`卸载确认对话框不可用，未执行卸载：${error instanceof Error ? error.message : String(error)}`)
  }
  return answer !== undefined && answer.selected[0] === CONFIRM_UNINSTALL_LABEL
}

/**
 * Run one pip install against the chosen source.
 * @param interpreter - target interpreter.
 * @param specs - requirement specs to install.
 * @param editables - local project directories to install with `-e`.
 * @param extras - validated extra pip flags.
 * @param source - mirror to use, or the unconfigured default.
 * @param signal - caller cancellation.
 * @returns Exit code and captured output.
 */
async function installPackages(interpreter, specs, editables, extras, source, signal) {
  const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input']
  if (source.url !== null) args.push('-i', source.url)
  args.push(...extras)
  args.push(...specs)
  for (const path of editables) args.push('-e', path)
  return runCapture(interpreter, args, signal, INSTALL_TIMEOUT_MS)
}

/**
 * Refuse any flag outside the allowlist, so a caller cannot re-point the index,
 * the target directory, or the interpreter behind the confirmation dialog.
 * @param value - raw `extraArgs` argument.
 * @returns Deduplicated flags in the order given.
 */
function validateExtraArgs(value, config = liveConfig) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('extraArgs must be an array of pip flags')
  const allowed = allowedExtraFlags(config)
  const flags = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) throw new Error('extraArgs entries must be non-empty strings')
    const token = entry.trim()
    if (!/^(--[a-z0-9][a-z0-9-]*|-[A-Za-z])(=[^\s;|&`$(){}"']*)?$/u.test(token)) {
      throw new Error(`extraArgs refuses ${JSON.stringify(token)}: not a plain pip flag`)
    }
    const name = flagName(token)
    if (HARD_BANNED_FLAGS.has(name)) {
      throw new Error(`extraArgs refuses ${name}: it changes the install source or target, which the confirmation dialog fixes. It is refused for every caller and cannot be allowlisted. Tell the user why it is needed instead of reaching for another command.`)
    }
    if (!allowed.has(name)) {
      throw new Error(`extraArgs refuses ${name}: it is not allowlisted. Tell the user it is needed and let them add it under Plugins → ${DISPLAY_TITLE} → 额外的 pip 参数; do not work around this with another command. Built-in flags: ${BUILTIN_EXTRA_FLAGS.join(', ')}`)
    }
    if (!flags.includes(token)) flags.push(token)
  }
  return flags
}

/**
 * Resolve editable project directories and confirm each one is a Python
 * project, so `-e` cannot point at an arbitrary path.
 * @param value - raw `editable` argument.
 * @param workspace - base directory for relative paths.
 * @returns Absolute project directories.
 */
async function resolveEditables(value, workspace) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('editable must be an array of local project directories')
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) throw new Error('editable entries must be local paths')
    const path = resolve(workspace, entry.trim())
    let entryStat
    try {
      entryStat = await stat(path)
    } catch {
      throw new Error(`editable path does not exist: ${path}`)
    }
    if (!entryStat.isDirectory()) throw new Error(`editable path is not a directory: ${path}`)
    if (!PROJECT_MARKERS.some(marker => existsSync(join(path, marker)))) {
      throw new Error(`editable path has none of ${PROJECT_MARKERS.join(', ')}: ${path}`)
    }
    if (!out.includes(path)) out.push(path)
  }
  return out
}

/**
 * Run a subprocess and report its exit code instead of rejecting on failure.
 * @param executable - program to run.
 * @param args - arguments.
 * @param signal - caller cancellation.
 * @param timeout - enforced budget in milliseconds.
 * @returns Exit code and both captured streams.
 */
function runCapture(executable, args, signal, timeout) {
  return new Promise((settle, reject) => {
    execFile(executable, args, {
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONWARNINGS: 'ignore',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
    }, (error, stdout, stderr) => {
      if (signal?.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        return
      }
      const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)
      settle({ code, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' })
    })
  })
}

/**
 * Keep the tail of a log so a failed install stays readable.
 * @param text - full log.
 * @param max - maximum characters retained.
 * @returns The truncated log with an explicit marker.
 */
function tail(text, max) {
  return text.length <= max ? text : `…(前 ${text.length - max} 字符省略)\n${text.slice(text.length - max)}`
}

/**
 * Render a tool result as the model-facing text.
 * @param value - canonical tool value.
 * @returns Bounded multi-line report.
 */
function renderValue(value) {
  if (value === null || typeof value !== 'object') return String(value)
  if (value.status !== undefined) {
    const lines = []
    const packages = Array.isArray(value.packages)
      ? value.packages.map(entry => entry.importable ? `${entry.name} ${entry.version ?? '?'}` : `${entry.name} —`).join(', ')
      : ''
    const source = value.source
    if (value.status === 'already-present') {
      lines.push(`nothing installed: every package already exists in ${value.interpreter}`)
      if (packages.length > 0) lines.push(packages)
    } else if (value.status === 'installed') {
      lines.push(`installed through ${source.label}${source.url === null ? '' : ` (${source.url})`} into ${value.interpreter}`)
      if (packages.length > 0) lines.push(packages)
      if (Array.isArray(value.editables) && value.editables.length > 0) lines.push(`editable: ${value.editables.join(', ')}`)
      if (Array.isArray(value.extras) && value.extras.length > 0) lines.push(`flags: ${value.extras.join(' ')}`)
    } else if (value.status === 'uninstalled') {
      lines.push(`removed from ${value.interpreter}`)
      if (packages.length > 0) lines.push(packages)
    } else if (value.status === 'nothing-to-remove') {
      lines.push(`nothing to remove: none of the requested packages are installed in ${value.interpreter}`)
    } else if (value.status === 'cancelled') {
      lines.push('install cancelled; nothing was changed')
      if (value.output) lines.push(value.output)
    } else if (value.status === 'unavailable') {
      lines.push('the confirmation dialog is unavailable, so nothing was installed')
      if (value.output) lines.push(value.output)
    } else {
      lines.push(`install failed through ${source.label}${source.url === null ? '' : ` (${source.url})`}`)
    }
    if (value.status === 'installed' || value.status === 'uninstalled' || value.status === 'failed') {
      if (value.output) lines.push('', value.output)
    }
    return lines.join('\n')
  }
  if (value.action === 'create_venv') {
    const lines = [
      `created ${value.venvPath}`,
      `interpreter: ${value.interpreter}${value.version ? ` (Python ${value.version})` : ''}`,
      `reuses system libraries: ${value.systemSitePackages ? 'yes (--system-site-packages)' : 'no'}`,
    ]
    if (value.packages.length > 0) {
      lines.push(`packages: ${value.packages.map(entry => entry.importable ? `${entry.name} ${entry.version ?? '?'}` : `${entry.name} —`).join(', ')}`)
      if (value.missing.length > 0) lines.push(`missing: ${value.missing.join(', ')}`)
    }
    return lines.join('\n')
  }

  const lines = [`workspace: ${value.workspace}`, `requested: ${value.requested.length > 0 ? value.requested.join(', ') : '(none)'}`]
  if (value.requested.length > 0) {
    lines.push(value.missingEverywhere.length === 0
      ? 'every requested package exists on this machine'
      : `missing everywhere: ${value.missingEverywhere.join(', ')}`)
  }
  if (value.servedBy.length > 0) lines.push(`already satisfied by: ${value.servedBy.join(', ')}`)
  if (value.recommended !== null) lines.push(`recommended interpreter: ${value.recommended}`)
  lines.push('interpreters:')
  for (const result of value.interpreters) lines.push(`  - ${describe(result, value.requested)}`)
  return lines.join('\n')
}
