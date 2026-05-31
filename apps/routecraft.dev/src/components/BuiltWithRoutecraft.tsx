export function BuiltWithRoutecraft() {
  return (
    <section className="bg-paper-deep/40">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-16">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <h2
              className="font-editorial text-[clamp(1.6rem,3vw,2.1rem)] leading-[1.2] tracking-[-0.01em] text-ink"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50' }}
            >
              Routecraft is the framework.{' '}
              <span
                className="text-cobalt-500 italic"
                style={{ fontVariationSettings: '"opsz" 96, "SOFT" 100' }}
              >
                DevOptix is the team that ships with it.
              </span>
            </h2>
            <p className="mt-4 max-w-2xl text-[1rem] leading-[1.65] text-ink/65">
              AI automation built and operated for SMBs and consultancies, by
              the people who wrote the framework.
            </p>
          </div>
          <a
            href="https://devoptix.nl/en/contact-us?utm_source=routecraft.dev&utm_medium=home-band&utm_campaign=routecraft-home"
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-2 self-start font-mono text-[0.7rem] tracking-[0.22em] text-cobalt-500 uppercase hover:text-cobalt-600 lg:self-center"
          >
            <span>Talk to us</span>
            <span
              aria-hidden="true"
              className="transition group-hover:translate-x-1"
            >
              ↗
            </span>
          </a>
        </div>
      </div>
    </section>
  )
}
