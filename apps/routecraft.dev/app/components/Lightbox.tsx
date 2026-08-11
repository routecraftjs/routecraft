import { type ReactNode, useState } from 'react'
import { Dialog, DialogBackdrop, DialogPanel } from '@headlessui/react'
import clsx from 'clsx'

/**
 * Artwork inside the overlay fills the available height and is allowed to
 * overflow the viewport horizontally, because fitting a 16:9 diagram inside a
 * phone's width would show it at the size it already had in the column, which
 * is not an enlargement. Above `sm` the panel is wide enough to fit the whole
 * thing, so it does.
 */
// `m-auto` rather than centring on the scroll container: `justify-content:
// center` centres overflowing content by pushing its start edge out of the
// scrollable area, where no amount of scrolling reaches it. Auto margins centre
// when there is room and collapse when there is not.
const ARTWORK =
  'm-auto max-h-[82vh] w-auto max-w-none border border-paper/15 object-contain sm:max-w-full'

/**
 * Full-screen overlay for a piece of post artwork. The trigger is whatever the
 * caller renders (an image, or a live DOM figure); the overlay is always an
 * image, so a drawing too dense to read in the column can open as a
 * full-resolution raster the reader can pan and pinch-zoom.
 *
 * The overlay is owned here rather than passed in, because the caller is often
 * a server component and anything it imported from this client module would
 * reach it as a client reference rather than the value.
 */
export function Lightbox({
  children,
  label,
  alt = '',
  caption,
  image,
  imageDark,
  className,
}: {
  /** The trigger: what sits in the flow of the post. */
  children: ReactNode
  /** Accessible name for the trigger button. */
  label: string
  alt?: string
  caption?: string
  /** Full-resolution image the overlay shows. */
  image: string
  /** Optional dark-theme counterpart, so an enlarged figure matches the page. */
  imageDark?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* The trigger sits over the artwork rather than wrapping it. A button
          may only contain phrasing content, and a figure is a div, so nesting
          one inside the button is invalid markup and lets a screen reader
          flatten the drawing into the button's name. An empty labelled button
          stretched across the artwork keeps the same click target and focus
          behaviour with a valid tree. */}
      <div className={clsx('group/lightbox relative', className)}>
        {children}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={label}
          className="absolute inset-0 h-full w-full cursor-zoom-in border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt-500"
        />
      </div>

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
          {/* The panel takes the full width it is given rather than sizing to
              its content, so artwork wider than the viewport scrolls inside the
              panel instead of pushing it off both edges of a fixed overlay,
              where neither end could be reached. */}
          <DialogPanel
            transition
            className="relative flex max-h-full w-full flex-col items-center gap-4 transition duration-300 ease-out data-[closed]:scale-[0.97] data-[closed]:opacity-0"
          >
            {/* Clicking the artwork closes, matching the zoom-out cursor; a pan
                gesture scrolls without firing a click. The caption below is not
                a target, so it stays outside. */}
            <div
              onClick={() => setOpen(false)}
              className="flex w-full cursor-zoom-out overflow-auto"
            >
              <img
                src={image}
                alt={alt}
                className={clsx(ARTWORK, imageDark && 'dark:hidden')}
              />
              {imageDark ? (
                <img
                  src={imageDark}
                  alt={alt}
                  className={clsx(ARTWORK, 'hidden dark:block')}
                />
              ) : null}
            </div>
            {caption && (
              <p className="max-w-2xl text-center font-mono text-[0.65rem] tracking-[0.2em] text-paper/55 uppercase">
                {caption}
              </p>
            )}
          </DialogPanel>
        </div>
      </Dialog>
    </>
  )
}

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
  if (!src) return null

  return (
    <Lightbox
      label={alt ? `Expand image: ${alt}` : 'Expand image'}
      alt={alt}
      caption={caption ?? title}
      image={src}
      className={className}
    >
      <img
        src={src}
        alt={alt}
        className="w-full transition duration-500 group-hover/lightbox:opacity-90"
      />
    </Lightbox>
  )
}
