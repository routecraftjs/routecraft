import glob from 'fast-glob'
import * as fs from 'fs'
import * as path from 'path'
import { createLoader } from 'simple-functional-loader'
import * as url from 'url'
import { cleanMarkdoc } from '../lib/clean-markdoc.mjs'

const __filename = url.fileURLToPath(import.meta.url)

function extractTitle(md) {
  const match = md.match(/^---[\s\S]*?---/)
  if (!match) return undefined
  const titleMatch = match[0].match(/^title:\s*(.+)$/m)
  return titleMatch
    ? titleMatch[1].trim().replace(/^["']|["']$/g, '')
    : undefined
}

export default function withDocsMarkdown(nextConfig = {}) {
  let cache = new Map()

  return Object.assign({}, nextConfig, {
    webpack(config, options) {
      config.module.rules.push({
        test: __filename,
        use: [
          createLoader(function () {
            let pagesDir = path.resolve('./src/app')
            this.addContextDependency(pagesDir)

            let files = glob.sync('**/page.md', { cwd: pagesDir })
            let pageMap = {}
            let allParts = []

            for (let file of files) {
              let pageUrl =
                file === 'page.md' ? '/' : `/${file.replace(/\/page\.md$/, '')}`
              let md = fs.readFileSync(path.join(pagesDir, file), 'utf8')

              let cleaned
              let title

              if (cache.get(file)?.[0] === md) {
                ;[, title, cleaned] = cache.get(file)
              } else {
                title = extractTitle(md)
                cleaned = cleanMarkdoc(md, title)
                cache.set(file, [md, title, cleaned])
              }

              pageMap[pageUrl] = cleaned
              allParts.push(cleaned)
            }

            let allDocs = allParts.join('\n---\n\n')

            return `
              let pages = ${JSON.stringify(pageMap)}
              let allDocs = ${JSON.stringify(allDocs)}

              export function getPageMarkdown(pathname) {
                // Try exact match, then with trailing slash stripped
                return pages[pathname] || pages[pathname.replace(/\\/$/, '')] || null
              }

              export function getAllDocsMarkdown() {
                return allDocs
              }

              export function getPageRawUrl(pathname, basePath) {
                let normalized = pathname === '/' ? '/index' : pathname.replace(/\\/$/, '')
                let prefix = basePath || ''
                return prefix + '/raw' + normalized + '.md'
              }

              export function getAllDocsRawUrl(basePath) {
                let prefix = basePath || ''
                return prefix + '/raw/docs.md'
              }
            `
          }),
        ],
      })

      if (typeof nextConfig.webpack === 'function') {
        return nextConfig.webpack(config, options)
      }

      return config
    },
  })
}
