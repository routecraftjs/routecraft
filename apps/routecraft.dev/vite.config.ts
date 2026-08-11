import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import mdx from '@mdx-js/rollup'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMdxFrontmatter from 'remark-mdx-frontmatter'
import { rehypeMarkdocSlug, remarkHeadingId } from './app/lib/mdx-plugins'

export default defineConfig({
  plugins: [
    tanstackStart({ srcDirectory: 'app' }),
    viteReact(),
    nitro({ preset: 'bun' }),
    tailwindcss(),
    {
      enforce: 'pre',
      ...mdx({
        providerImportSource: '@mdx-js/react',
        remarkPlugins: [
          remarkFrontmatter,
          [remarkMdxFrontmatter, { name: 'frontmatter' }],
          remarkHeadingId,
        ],
        rehypePlugins: [rehypeMarkdocSlug],
      }),
    },
  ],
})
