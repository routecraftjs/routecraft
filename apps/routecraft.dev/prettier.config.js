/** @type {import('prettier').Options} */
const config = {
  singleQuote: true,
  semi: false,
  plugins: ['prettier-plugin-tailwindcss'],
  tailwindStylesheet: './app/styles/tailwind.css',
}

export default config
