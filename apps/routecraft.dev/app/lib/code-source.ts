/**
 * Pulls the source text and language out of the `pre`/`code` pair MDX produces.
 *
 * `Fence` was written against Markdoc, which handed it the raw code as a
 * string. MDX hands it an element tree instead, so the string is recovered here
 * rather than by rewriting the component.
 *
 * `CodeTabs` needs the same recovery but cannot get it from the MDX component
 * map: it reads props off its `CodeTab` children instead of rendering them, so
 * a mapped `CodeTab` never runs and the raw `pre` element reaches it untouched.
 */

import { isValidElement } from 'react'
import type { ReactNode } from 'react'

export interface CodeSource {
  code: string
  language: string
}

export function readCodeSource(children: ReactNode): CodeSource {
  // A fence arrives as the `code` element; the same fence inside a `CodeTab`
  // arrives wrapped in its `pre`. Descend until the children are the source.
  let node: ReactNode = children

  while (isValidElement(node)) {
    const props = node.props as { className?: string; children?: ReactNode }

    if (typeof props.children === 'string') {
      return {
        // MDX keeps the fence's closing newline; Markdoc did not hand one over.
        code: props.children.replace(/\n$/, ''),
        language: /language-([\w-]+)/.exec(props.className ?? '')?.[1] ?? '',
      }
    }

    node = props.children
  }

  return { code: typeof children === 'string' ? children : '', language: '' }
}
