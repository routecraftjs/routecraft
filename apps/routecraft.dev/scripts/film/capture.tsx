import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

import { FilmFrame } from '../../app/components/film/FilmFrame'

declare global {
  interface Window {
    filmFrame: (t: number) => void
  }
}

const root = createRoot(document.getElementById('film') as HTMLElement)

window.filmFrame = (t) => {
  flushSync(() => root.render(<FilmFrame t={t} />))
}
