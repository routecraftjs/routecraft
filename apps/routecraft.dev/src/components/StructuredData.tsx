// Renders a JSON-LD <script> for a schema.org object. Server-rendered into the
// static HTML so crawlers get structured data without executing JS.
export function StructuredData({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // The payload is built from trusted, static content (site config and
      // blog frontmatter), so stringifying it directly is safe here.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  )
}
