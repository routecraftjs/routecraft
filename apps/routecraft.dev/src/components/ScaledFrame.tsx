import type { CSSProperties } from 'react'

/**
 * Responsive scaler for fixed-size DOM artwork. Wraps children in an SVG with a
 * viewBox so a composition authored at exact pixel dimensions (covers, figures)
 * scales natively: no JS, no transform maths, no reflow at intermediate widths.
 *
 * Two modes:
 *  - default: width 100%, height derived from the aspect ratio. Use when the
 *    container matches that aspect or has no fixed height.
 *  - fill: the SVG fills its positioned parent and crops like
 *    `object-fit: cover`, anchored left so leading content stays in frame.
 */
export function ScaledFrame({
  width,
  height,
  children,
  className,
  fill = false,
  role = 'img',
  label,
}: {
  width: number
  height: number
  children: React.ReactNode
  className?: string
  fill?: boolean
  role?: string
  /** Accessible name. Rendered as <title>, which screen readers announce. */
  label?: string
}) {
  const style: CSSProperties = fill
    ? {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
      }
    : {
        display: 'block',
        width: '100%',
        height: 'auto',
        // Explicit ratio so the height is definite cross-browser. Safari does
        // not infer an inline SVG's height from its viewBox when height is auto
        // (the foreignObject content then collapses on mobile), so pin it here.
        aspectRatio: `${width} / ${height}`,
      }

  return (
    <svg
      className={className}
      role={role}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={fill ? 'xMinYMid slice' : 'xMidYMid meet'}
      style={style}
    >
      {label ? <title>{label}</title> : null}
      <foreignObject x={0} y={0} width={width} height={height}>
        {children}
      </foreignObject>
    </svg>
  )
}
