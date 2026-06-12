'use client'

import { useState } from 'react'
import { Dialog, DialogBackdrop, DialogPanel } from '@headlessui/react'
import clsx from 'clsx'

/**
 * A content image that expands into a full-screen lightbox on click. Used for
 * every image inside a post: the hero, standalone markdown images, and figures.
 * The overlay shows the image at full resolution (the site ships unoptimized
 * images, so the same `src` is the high-quality original).
 */
export function LightboxImage({
  src,
  alt = '',
  caption,
  title,
  className,
}: {
  src?: string
  alt?: string
  caption?: string
  /** Markdown image title (`![alt](src "title")`); used as the overlay caption. */
  title?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  if (!src) return null

  const overlayCaption = caption ?? title

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={alt ? `Expand image: ${alt}` : 'Expand image'}
        className={clsx(
          'group/lightbox block w-full cursor-zoom-in border-0 bg-transparent p-0',
          className,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className="w-full transition duration-500 group-hover/lightbox:opacity-90"
        />
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        className="relative z-[60]"
      >
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-ink/90 backdrop-blur-sm transition duration-300 ease-out data-[closed]:opacity-0"
        />

        <button
          type="button"
          onClick={() => setOpen(false)}
          className="fixed top-5 right-5 z-10 inline-flex items-center gap-2 font-mono text-[0.65rem] tracking-[0.22em] text-paper/70 uppercase transition hover:text-paper sm:top-7 sm:right-7"
        >
          <span>Close</span>
          <span aria-hidden="true" className="text-[0.9rem] leading-none">
            ✕
          </span>
        </button>

        <div className="fixed inset-0 flex items-center justify-center p-4 sm:p-10">
          <DialogPanel
            transition
            className="relative flex max-h-full flex-col items-center gap-4 transition duration-300 ease-out data-[closed]:scale-[0.97] data-[closed]:opacity-0"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt}
              onClick={() => setOpen(false)}
              className="max-h-[82vh] w-auto max-w-full cursor-zoom-out border border-paper/15 object-contain"
            />
            {overlayCaption && (
              <figcaption className="max-w-2xl text-center font-mono text-[0.65rem] tracking-[0.2em] text-paper/55 uppercase">
                {overlayCaption}
              </figcaption>
            )}
          </DialogPanel>
        </div>
      </Dialog>
    </>
  )
}
