/** Directories the build-time generators read from and write to. */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

export const APP_DIR = path.join(ROOT, 'app')
export const CONTENT_DIR = path.join(APP_DIR, 'content')
export const GENERATED_DIR = path.join(APP_DIR, 'lib', 'generated')
export const PUBLIC_DIR = path.join(ROOT, 'public')
