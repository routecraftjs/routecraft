/**
 * The one line on routecraft.dev that names DevOptix. It closes the page as a
 * contained panel rather than a full-bleed band, so its tint keeps to the same
 * column as every section above it and never meets the footer's own tint.
 */
export function BuiltWithRoutecraft() {
  return (
    <section>
      <div className="container-page pt-4 pb-20 lg:pb-24">
        <div className="grid grid-cols-1 gap-8 border border-ink/15 bg-paper-deep/40 px-6 py-10 sm:px-10 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-16 lg:px-12 lg:py-12">
          <div>
            <h2
              className="font-editorial text-[clamp(1.6rem,3vw,2.1rem)] leading-[1.2] tracking-[-0.01em] text-balance text-ink"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50' }}
            >
              Routecraft is the platform.{' '}
              <span
                className="text-cobalt-500 italic"
                style={{ fontVariationSettings: '"opsz" 96, "SOFT" 100' }}
              >
                DevOptix is the team that builds and runs it with you.
              </span>
            </h2>
            <p className="mt-4 max-w-2xl text-[1rem] leading-[1.65] text-ink/65">
              AI automation built and operated for SMBs and consultancies, by
              the people who build the platform.
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
