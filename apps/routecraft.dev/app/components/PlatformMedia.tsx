import { Diagram } from '@/components/figures/Diagram'

/**
 * The homepage's picture of the platform. It is a 16:9 still for now; the
 * narrated film is drawn on the same 16:9 canvas and replaces this component
 * when it is ready, so the page around it does not change.
 */
export function PlatformMedia() {
  return <Diagram id="platform" />
}
