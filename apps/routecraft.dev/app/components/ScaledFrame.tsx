import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Responsive scaler for fixed-size DOM artwork (covers, figures, motifs). A
 * composition authored at exact pixel dimensions is scaled to whatever width
 * its container offers, so it never reflows: the same drawing at every width,
 * just smaller.
 *
 * It measures its own width and applies a CSS `transform: scale()`, rather than
 * wrapping the artwork in an SVG `viewBox` + `<foreignObject>`. The SVG route
 * is prettier (pure CSS, no measurement) but WebKit paints foreignObject HTML
 * at 1:1, ignoring the viewBox scale, as soon as anything in the subtree is
 * positioned. Every one of these drawings positions something, so on Safari the
 * result was the top-left corner of the canvas at full size: covers with no
 * title, figures showing one label and acres of empty paper. Do not go back to
 * foreignObject scaling without checking Safari.
 *
 * The artwork stays hidden until the first measurement, so nothing paints at
 * the wrong size on the way in. The frame reserves its space through
 * `aspect-ratio`, so revealing it shifts no layout. With scripting off it never
 * measures, and `tailwind.css` shows the artwork at 1:1 in a pannable frame
 * instead of leaving an empty box.
 */
export function ScaledFrame({
  width,
  height,
  children,
  className,
  role = 'img',
  label,
}: {
  width: number
  height: number
  children: React.ReactNode
  className?: string
  role?: string
  /** Accessible name. A frame without one is decoration; leave it unset. */
  label?: string
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState<number | null>(null)

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    const measure = () => {
      // clientWidth excludes any border on the frame, which is what the
      // artwork actually has to fit inside.
      setScale(frame.clientWidth / width)
    }
    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [width])

  return (
    <div
      ref={frameRef}
      data-scaled-frame=""
      className={className}
      role={role}
      aria-label={label}
      style={{
        width: '100%',
        aspectRatio: `${width} / ${height}`,
        overflow: 'hidden',
      }}
    >
      <div
        data-scaled-frame-art=""
        style={{
          width,
          height,
          transformOrigin: '0 0',
          ...(scale === null
            ? { visibility: 'hidden' as const }
            : { transform: `scale(${scale})` }),
        }}
      >
        {children}
      </div>
    </div>
  )
}
