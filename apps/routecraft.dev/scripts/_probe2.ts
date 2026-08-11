const r = await fetch(
  'https://cdn.jsdelivr.net/fontsource/fonts/fraunces@latest/latin-400-normal.ttf',
  { verbose: true } as RequestInit,
)
console.log(r.status, (await r.arrayBuffer()).byteLength)
