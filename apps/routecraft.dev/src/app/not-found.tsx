import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="max-w-2xl min-w-0 flex-auto px-4 py-16 lg:max-w-none lg:pr-0 lg:pl-8 xl:px-16">
      <div className="flex h-full flex-col items-center justify-center text-center">
        <p className="font-mono text-[0.65rem] font-medium tracking-[0.22em] text-cobalt-500 uppercase">
          404
        </p>
        <h1 className="mt-3 font-editorial text-4xl tracking-[-0.02em] text-ink">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-ink/55">
          Sorry, we couldn’t find the page you’re looking for.
        </p>
        <Link
          href="/"
          className="mt-8 font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase hover:text-cobalt-600"
        >
          Go back home ↗
        </Link>
      </div>
    </div>
  )
}
