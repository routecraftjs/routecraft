import { type SearchOptions } from 'flexsearch'

declare module '@/markdoc/docs-markdown.mjs' {
  export function getPageMarkdown(pathname: string): string | null
  export function getAllDocsMarkdown(): string
  export function getPageRawUrl(pathname: string, basePath?: string): string
  export function getAllDocsRawUrl(basePath?: string): string
}

declare module '@/markdoc/search.mjs' {
  export type Result = {
    url: string
    title: string
    pageTitle?: string
  }

  export function search(query: string, options?: SearchOptions): Array<Result>
}
