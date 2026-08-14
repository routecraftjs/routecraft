#!/usr/bin/env bun

/**
 * TEMPORARY: prints why the Vite config will not load.
 *
 * `vite build` reports a bare `ResolveMessage {}` when the config's import
 * graph fails to resolve, which names neither the specifier nor the importer.
 * This imports the config the same way and prints the resolver's own fields.
 * Delete once the CI failure it exists to diagnose is understood.
 */

const target = new URL('../vite.config.ts', import.meta.url).pathname

try {
  await import(target)
  console.log(`config-probe: ${target} imported cleanly`)
} catch (error) {
  console.error('config-probe: import failed')
  console.error('  name      :', (error as Error)?.name)
  console.error('  message   :', (error as Error)?.message)
  for (const key of ['specifier', 'importKind', 'referrer', 'position']) {
    const value = (error as unknown as Record<string, unknown>)[key]
    if (value !== undefined) console.error(`  ${key.padEnd(10)}:`, value)
  }
  console.error('  stack     :', (error as Error)?.stack)
  process.exit(1)
}
