'use client'

import { useMemo, useState } from 'react'
import clsx from 'clsx'

import type { BlogPostMeta } from '@/lib/blog'
import { BlogCard } from '@/components/BlogCard'
import { SectionLabel } from '@/components/SectionLabel'

// How many posts to reveal per "Load more" click. Keeps the initial paint and
// the DOM bounded no matter how many posts the archive grows to.
const BATCH = 9

// Cap the inline tag chips so the filter bar stays a tidy row or two however
// large the tag vocabulary grows. The rest fold behind a "+N more" toggle and
// stay findable via the search box.
const MAX_VISIBLE_TAGS = 8

/**
 * The filterable, incrementally-loaded post grid below the featured section.
 * Filtering and pagination run in the browser because the site is a static
 * export: the full (lightweight) post metadata is already shipped, so there is
 * no request to make. Selecting tags narrows to posts matching ANY selected tag;
 * the search box matches title, description, and tags.
 */
export function BlogIndex({ posts }: { posts: BlogPostMeta[] }) {
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(BATCH)
  const [tagsExpanded, setTagsExpanded] = useState(false)

  // Tags ordered by how often they appear, so the most useful filters lead.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const post of posts) {
      for (const tag of post.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag)
  }, [posts])

  // Collapsed, show the top tags plus any selected tag that would otherwise be
  // hidden, so an active filter never disappears off the end of the list.
  const visibleTags = useMemo(() => {
    if (tagsExpanded) return allTags
    const top = allTags.slice(0, MAX_VISIBLE_TAGS)
    const pinned = selectedTags.filter((tag) => !top.includes(tag))
    return [...top, ...pinned]
  }, [allTags, tagsExpanded, selectedTags])

  const hiddenTagCount = allTags.length - visibleTags.length

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return posts.filter((post) => {
      const matchesTags =
        selectedTags.length === 0 ||
        (post.tags ?? []).some((tag) => selectedTags.includes(tag))
      if (!matchesTags) return false
      if (!needle) return true
      const haystack = [
        post.title,
        post.description ?? '',
        ...(post.tags ?? []),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [posts, selectedTags, query])

  const shown = filtered.slice(0, visible)
  const hasFilters = selectedTags.length > 0 || query.trim().length > 0

  // Changing a filter is a user action, so the window resets to the first batch
  // right here in the handler rather than in an effect.
  function toggleTag(tag: string) {
    setSelectedTags((current) =>
      current.includes(tag)
        ? current.filter((t) => t !== tag)
        : [...current, tag],
    )
    setVisible(BATCH)
  }

  function changeQuery(value: string) {
    setQuery(value)
    setVisible(BATCH)
  }

  function clearFilters() {
    setSelectedTags([])
    setQuery('')
    setVisible(BATCH)
  }

  return (
    <section className="mt-24">
      <SectionLabel label="All posts" />

      <div className="mt-8 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setSelectedTags([])
                setVisible(BATCH)
              }}
              aria-pressed={selectedTags.length === 0}
              className={chipClass(selectedTags.length === 0)}
            >
              All
            </button>
            {visibleTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                aria-pressed={selectedTags.includes(tag)}
                className={chipClass(selectedTags.includes(tag))}
              >
                {tag}
              </button>
            ))}
            {!tagsExpanded && hiddenTagCount > 0 && (
              <button
                type="button"
                onClick={() => setTagsExpanded(true)}
                className="px-2 py-1.5 font-mono text-[0.65rem] tracking-[0.2em] text-cobalt-500 uppercase transition hover:text-cobalt-600"
              >
                +{hiddenTagCount} more
              </button>
            )}
            {tagsExpanded && allTags.length > MAX_VISIBLE_TAGS && (
              <button
                type="button"
                onClick={() => setTagsExpanded(false)}
                className="px-2 py-1.5 font-mono text-[0.65rem] tracking-[0.2em] text-cobalt-500 uppercase transition hover:text-cobalt-600"
              >
                Show less
              </button>
            )}
          </div>
        )}

        <label className="relative block shrink-0 lg:w-64">
          <span className="sr-only">Search posts</span>
          <input
            type="search"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            placeholder="Search posts"
            className="w-full border border-ink/20 bg-transparent px-3 py-2 font-mono text-[0.7rem] tracking-[0.12em] text-ink uppercase transition placeholder:text-ink/40 focus:border-cobalt-500 focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-5 flex items-center gap-4">
        <span className="font-mono text-[0.65rem] tracking-[0.2em] text-ink/45 uppercase">
          {filtered.length} {filtered.length === 1 ? 'post' : 'posts'}
        </span>
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="font-mono text-[0.65rem] tracking-[0.2em] text-cobalt-500 uppercase transition hover:text-cobalt-600"
          >
            Clear filters
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="mt-10 border border-dashed border-ink/30 p-12 text-center">
          <p className="font-editorial text-[1.25rem] tracking-[-0.01em] text-ink italic">
            No posts match those filters.
          </p>
          <button
            type="button"
            onClick={clearFilters}
            className="mt-4 font-mono text-[0.65rem] tracking-[0.2em] text-cobalt-500 uppercase transition hover:text-cobalt-600"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((post) => (
              <BlogCard key={post.slug} post={post} />
            ))}
          </div>

          {filtered.length > visible && (
            <div className="mt-12 flex justify-center">
              <button
                type="button"
                onClick={() => setVisible((v) => v + BATCH)}
                className="group inline-flex items-center gap-2 border border-ink/30 px-5 py-3 font-mono text-[0.7rem] tracking-[0.22em] text-ink uppercase transition hover:border-cobalt-500 hover:text-cobalt-500"
              >
                <span>Load more ({filtered.length - visible} more)</span>
                <span
                  aria-hidden="true"
                  className="transition group-hover:translate-y-0.5"
                >
                  ↓
                </span>
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function chipClass(active: boolean): string {
  return clsx(
    'border px-3 py-1.5 font-mono text-[0.65rem] tracking-[0.2em] uppercase transition',
    active
      ? 'border-cobalt-500 bg-cobalt-500 text-paper'
      : 'border-ink/20 text-ink/55 hover:border-cobalt-500 hover:text-cobalt-500',
  )
}
