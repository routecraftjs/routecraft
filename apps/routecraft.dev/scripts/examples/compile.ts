/**
 * Compiles extracted documentation examples against the workspace packages.
 *
 * Examples are written to be read, not to be compiled: a block is usually a
 * fragment that names `craft` or `json` without importing them. Rather than
 * demand imports on every block, which would add more lines of ceremony than
 * code to a median seven-line example, the missing imports are synthesised.
 *
 * The synthesis is driven by the compiler's own diagnostics. A block is
 * compiled bare, every `Cannot find name` is collected, and each name the
 * workspace packages export is imported before the block is compiled again.
 * Deriving the set from diagnostics rather than from a hand-written scope
 * analysis is what makes it safe: a name that already resolves, to a local
 * declaration or to anything else, never raises the diagnostic, so a synthetic
 * import cannot shadow it.
 *
 * The DOM lib is deliberately absent. `lib.dom` declares globals that collide
 * with package exports, `event` among them, and a colliding global resolves
 * silently: the block never raises `Cannot find name`, never gets its import,
 * and is checked against `Window.event` instead of the adapter it is
 * documenting.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import type { ExampleBlock } from './extract.ts'

const require_ = createRequire(import.meta.url)
const ts = require_('typescript') as typeof import('typescript')

/** Packages whose exports may be imported into an example without ceremony. */
export const WORKSPACE_PACKAGES = ['routecraft', 'ai', 'testing', 'os'] as const

/**
 * Third-party modules an example may use unqualified.
 *
 * Kept deliberately short. A wider list would compile more blocks at the cost
 * of teaching a vocabulary the documentation does not actually use.
 */
export const BARE_IMPORTS: Readonly<Record<string, string>> = {
  z: 'zod',
  StandardSchemaV1: '@standard-schema/spec',
}

export interface MappedDiagnostic {
  /** Absolute path of the documentation file, never the generated file. */
  file: string
  /** 1-based line in the documentation file. */
  line: number
  /** 1-based column in the documentation file. */
  column: number
  code: number
  message: string
}

/**
 * What happened to one block.
 *
 * `skip-unnecessary` and `unexpectedly-compiled` are the same enforcement
 * applied to the two markers, and they are kept apart because the fix differs.
 * A block that compiles despite `skip` has outgrown its excuse and the marker
 * should go. A block that compiles despite `expect-error` means the error the
 * page teaches is no longer an error, which is usually the framework moving
 * under a migration guide.
 */
export interface BlockOutcome {
  block: ExampleBlock
  status:
    'ok' | 'failed' | 'skipped' | 'skip-unnecessary' | 'unexpectedly-compiled'
  diagnostics: MappedDiagnostic[]
}

export interface CompileOptions {
  repoRoot: string
  /** Directory the generated files are written to. Cleared on every run. */
  workDir: string
}

function compilerOptions(
  repoRoot: string,
): import('typescript').CompilerOptions {
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // See the module JSDoc: lib.dom's globals mask package exports.
    lib: ['lib.esnext.d.ts'],
    types: ['node'],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    moduleDetection: ts.ModuleDetectionKind.Force,
    // An example legitimately declares a value to show its shape and then
    // never reads it; that is documentation, not dead code.
    noUnusedLocals: false,
    noUnusedParameters: false,
    baseUrl: repoRoot,
    paths: {
      '@routecraft/testing': ['packages/testing/src/index.ts'],
      '@routecraft/*': ['packages/*/src/index.ts'],
    },
  }
}

/**
 * Maps every identifier the workspace packages export to the module that
 * exports it.
 *
 * Where two packages export the same name the first wins, following the order
 * of {@link WORKSPACE_PACKAGES}, so core beats the satellites.
 */
export function buildExportMap(repoRoot: string): Map<string, string> {
  const entries = WORKSPACE_PACKAGES.map((name) =>
    path.join(repoRoot, `packages/${name}/src/index.ts`),
  )
  const program = ts.createProgram(entries, compilerOptions(repoRoot))
  const checker = program.getTypeChecker()
  const map = new Map<string, string>()

  entries.forEach((entry, index) => {
    const source = program.getSourceFile(entry)
    if (!source) return
    const symbol = checker.getSymbolAtLocation(source)
    if (!symbol) return
    for (const exported of checker.getExportsOfModule(symbol)) {
      if (!map.has(exported.name)) {
        map.set(exported.name, `@routecraft/${WORKSPACE_PACKAGES[index]}`)
      }
    }
  })

  for (const [name, module] of Object.entries(BARE_IMPORTS)) {
    if (!map.has(name)) map.set(name, module)
  }

  return map
}

interface Generated {
  block: ExampleBlock
  file: string
  /** Lines of synthesised imports standing above the block's own first line. */
  prelude: number
}

function write(generated: Generated, prelude: string[]): void {
  generated.prelude = prelude.length
  writeFileSync(
    generated.file,
    [...prelude, generated.block.code, ''].join('\n'),
  )
}

/**
 * Collects diagnostics for the generated files only.
 *
 * Diagnostics are requested per file rather than for the whole program.
 * Package source is in the program because `paths` points at it, and checking
 * all of it here would both duplicate the packages' own typecheck and dominate
 * the runtime.
 */
function diagnosticsByFile(
  program: import('typescript').Program,
  files: readonly string[],
): Map<string, import('typescript').Diagnostic[]> {
  const byFile = new Map<string, import('typescript').Diagnostic[]>()

  for (const file of files) {
    const source = program.getSourceFile(file)
    if (!source) continue
    const diagnostics = [
      ...program.getSemanticDiagnostics(source),
      ...program.getSyntacticDiagnostics(source),
    ]
    if (diagnostics.length) byFile.set(path.resolve(file), [...diagnostics])
  }

  return byFile
}

/**
 * Whether a block augments a module or the global scope.
 *
 * TypeScript applies such a declaration to every file in the program, so a
 * page that registers a `direct()` endpoint would silently make that endpoint
 * name valid in every other page's examples. Blocks like this are compiled on
 * their own for that reason.
 */
function augmentsGlobalScope(code: string): boolean {
  return /^\s*declare\s+(module|global)\b/m.test(code)
}

/**
 * Lib and package sources parsed once and shared by every program in a run.
 *
 * Each block that augments module scope needs its own program, and each of
 * those otherwise re-parses the whole of `packages/*` and the lib files from
 * nothing. That parse is almost all of a program's cost here, since the blocks
 * themselves are a few lines each. Only files outside the work directory are
 * cached: the generated block files are rewritten between the two passes, so
 * caching those would hand the second pass the first pass's text.
 */
const parsedSources = new Map<
  string,
  import('typescript').SourceFile | undefined
>()

function cachingHost(
  options: import('typescript').CompilerOptions,
  workDir: string,
): import('typescript').CompilerHost {
  const host = ts.createCompilerHost(options)
  const readSourceFile = host.getSourceFile.bind(host)

  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    if (path.resolve(name).startsWith(workDir)) {
      return readSourceFile(name, languageVersion, onError, shouldCreate)
    }
    if (!parsedSources.has(name)) {
      parsedSources.set(
        name,
        readSourceFile(name, languageVersion, onError, shouldCreate),
      )
    }
    return parsedSources.get(name)
  }

  return host
}

/**
 * Runs one program over the given files and returns their diagnostics.
 *
 * Each program is built fresh. Chaining them through `oldProgram` looks like an
 * easy saving and is not: reuse across differing root-file sets breaks module
 * resolution inside `declare module` blocks, which then report TS2664 against
 * a module that resolves perfectly well on its own.
 */
function run(
  files: string[],
  options: import('typescript').CompilerOptions,
  workDir: string,
): Map<string, import('typescript').Diagnostic[]> {
  const program = ts.createProgram(
    files,
    options,
    cachingHost(options, workDir),
  )
  return diagnosticsByFile(program, files)
}

/**
 * Compiles every generated file, isolating the ones that augment module or
 * global scope so their declarations cannot reach another page's example.
 */
function checkAll(
  generated: readonly Generated[],
  options: import('typescript').CompilerOptions,
  workDir: string,
): Map<string, import('typescript').Diagnostic[]> {
  const shared = generated.filter((g) => !augmentsGlobalScope(g.block.code))
  const isolated = generated.filter((g) => augmentsGlobalScope(g.block.code))

  const all = new Map<string, import('typescript').Diagnostic[]>()

  if (shared.length) {
    for (const [file, diagnostics] of run(
      shared.map((g) => g.file),
      options,
      workDir,
    )) {
      all.set(file, diagnostics)
    }
  }

  for (const item of isolated) {
    for (const [file, diagnostics] of run([item.file], options, workDir))
      all.set(file, diagnostics)
  }

  return all
}

/** Names the compiler could not resolve, as reported for one generated file. */
function unresolvedNames(
  diagnostics: import('typescript').Diagnostic[],
): string[] {
  const names: string[] = []
  for (const diagnostic of diagnostics) {
    // 2304 is "Cannot find name"; 2552 is the same with a spelling suggestion.
    if (diagnostic.code !== 2304 && diagnostic.code !== 2552) continue
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    const match = /Cannot find name '([^']+)'/.exec(text)
    if (match) names.push(match[1])
  }
  return names
}

/**
 * Modules a block augments with `declare module`.
 *
 * An augmentation binds to a module that is already part of the program, so an
 * isolated block augmenting `@routecraft/ai` without importing it reports
 * TS2664. A real project has the module in scope through its own imports; a
 * type-only import gives the block the same footing without adding a binding.
 */
function augmentedModules(code: string): string[] {
  const found = new Set<string>()
  const pattern = /^\s*declare\s+module\s+['"]([^'"]+)['"]/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code))) found.add(match[1])
  return [...found]
}

function synthesisePrelude(
  names: string[],
  exports: Map<string, string>,
): string[] {
  const byModule = new Map<string, Set<string>>()
  for (const name of names) {
    const module = exports.get(name)
    if (!module) continue
    const bucket = byModule.get(module)
    if (bucket) bucket.add(name)
    else byModule.set(module, new Set([name]))
  }

  return [...byModule]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([module, names]) =>
        `import { ${[...names].sort().join(', ')} } from '${module}'`,
    )
}

/**
 * Rewrites a diagnostic's position from the generated file back to the
 * documentation file the author edits.
 *
 * A diagnostic that lands inside the synthesised prelude is pinned to the
 * block's first line: the prelude is not a place an author can go and look.
 */
function mapDiagnostic(
  diagnostic: import('typescript').Diagnostic,
  generated: Generated,
): MappedDiagnostic {
  const { block, prelude } = generated
  const source = diagnostic.file
  const position = diagnostic.start ?? 0
  const { line, character } = source
    ? source.getLineAndCharacterOfPosition(position)
    : { line: prelude, character: 0 }

  const withinCode = Math.max(0, line - prelude)
  return {
    file: block.file,
    line: block.codeLine + withinCode,
    column: character + 1 + (line >= prelude ? block.indent : 0),
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  }
}

/**
 * Compiles every block, synthesising the imports each one turns out to need.
 *
 * Blocks marked `skip` are written but never compiled. Blocks marked
 * `expect-error` are compiled and must fail; one that compiles is reported as
 * `unexpectedly-compiled`, because a page teaching that something is an error
 * has become a page telling a lie.
 */
export function compileBlocks(
  blocks: ExampleBlock[],
  options: CompileOptions,
): BlockOutcome[] {
  const { repoRoot, workDir } = options
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })

  // Skipped blocks are compiled too. A marker is a claim that a block cannot
  // compile, and an unaudited claim is how a rewritten page carries a stale
  // marker forward and quietly stops being checked.
  const generated: Generated[] = blocks.map((block, index) => ({
    block,
    file: path.join(workDir, `block-${String(index).padStart(4, '0')}.ts`),
    prelude: 0,
  }))

  for (const item of generated) write(item, [])

  const exports = buildExportMap(repoRoot)
  const options_ = compilerOptions(repoRoot)

  // Pass one establishes which names do not resolve; pass two checks the block
  // with those names imported.
  const first = checkAll(generated, options_, workDir)
  for (const item of generated) {
    const names = unresolvedNames(first.get(path.resolve(item.file)) ?? [])
    const seeds = augmentedModules(item.block.code).map(
      (m) => `import type {} from '${m}'`,
    )
    const prelude = [...seeds, ...synthesisePrelude(names, exports)]
    if (prelude.length) write(item, prelude)
  }

  const second = checkAll(generated, options_, workDir)

  const outcomes = new Map<ExampleBlock, BlockOutcome>()
  for (const item of generated) {
    const diagnostics = second.get(path.resolve(item.file)) ?? []

    if (item.block.marker.kind === 'expect-error') {
      outcomes.set(item.block, {
        block: item.block,
        status: diagnostics.length ? 'ok' : 'unexpectedly-compiled',
        diagnostics: [],
      })
      continue
    }

    if (item.block.marker.kind === 'skip') {
      outcomes.set(item.block, {
        block: item.block,
        status: diagnostics.length ? 'skipped' : 'skip-unnecessary',
        diagnostics: [],
      })
      continue
    }

    outcomes.set(item.block, {
      block: item.block,
      status: diagnostics.length ? 'failed' : 'ok',
      diagnostics: diagnostics.map((d) => mapDiagnostic(d, item)),
    })
  }

  // Outcomes come back in the order the blocks were given, so a caller can pair
  // them with its own list without matching on identity.
  return blocks.map(
    (block) =>
      outcomes.get(block) ?? {
        block,
        status: 'failed' as const,
        diagnostics: [],
      },
  )
}
