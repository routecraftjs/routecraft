---
title: carddav
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
carddav(options?: CardDAVReadOptions): Source<VCardBody> & Destination<unknown, VCardBody[]>
carddav(options: CardDAVWriteOptions): Destination<VCardBody, CardDAVWriteResult>
carddav(options: CardDAVDeleteOptions): Destination<unknown, CardDAVDeleteResult>
```

Read and write contacts over CardDAV. Defaults to Apple iCloud Contacts (`https://contacts.icloud.com`) but works with any CardDAV server (Fastmail, Nextcloud, Google). The role is chosen by an `action` flag, the same way the mail adapter selects its mode: no `action` reads, `action` writes or deletes.

The body is a plain [`VCardBody`](#the-vcard-document) (a `version` plus a property list), not a typed contact object. Wrap it in a [`VCard`](#the-vcard-document) for ergonomic reads and edits, then read `.data` to put the plain body back, exactly like working with parsed JSON from an HTTP endpoint. DAV identity (`url`/`uid`/`etag`) lives on the exchange headers (`routecraft.carddav.*`), not the body, the same way the mail adapter carries its envelope. Reading is lossless, so a read-modify-write keeps everything you did not change.

Requires the optional peer `tsdav` (DAV client): `bun add tsdav`. A missing peer raises `RC5017` with an install hint.

**Credentials** live in context config as named accounts. For iCloud, `username` is your Apple ID and `appPassword` is an [app-specific password](https://support.apple.com/en-us/102654) (not your account password).

```ts
import { defineConfig } from '@routecraft/routecraft'

export default defineConfig({
  carddav: {
    accounts: {
      default: {
        username: process.env.ICLOUD_ID!,
        appPassword: process.env.ICLOUD_APP_PW!,
      },
      work: {
        username: 'me@work.com',
        appPassword: process.env.WORK_APP_PW!,
        serverUrl: 'https://dav.fastmail.com', // per-account override
        addressBook: 'Colleagues',             // per-account default book
      },
    },
    serverUrl: 'https://contacts.icloud.com',   // global default
    addressBook: 'Card',                        // global default book
  },
})
```

**Read (`.from()`):** no `action`. Emits one `VCardBody` per address-book entry. This is a one-shot fetch-all; pair it with a scheduler for periodic reads.

```ts
craft()
  .id('contacts-export')
  .from(carddav())
  .transform((body) => {
    const card = VCard.wrap(body)
    return { name: card.text('FN'), email: card.text('EMAIL') }
  })
  .to(log())

craft().from(carddav({ account: 'work', addressBook: 'Colleagues', limit: 500 })).to(...)
```

**Read (`.enrich()`):** no `action`. Fetches all contacts and merges them onto the triggering exchange (the default aggregator spreads the array onto the body with numeric keys, as with `mail`; pass `replace()` for a `VCardBody[]` body).

```ts
craft()
  .from(cron('0 2 * * *'))
  .enrich(carddav())
  .to(writeCsv('contacts.csv'))
```

**Write (`.to()`):** a write serializes the whole body and replaces the card; it does not merge. Because reading is lossless, a read-modify-write keeps every property you did not touch, and removing a property removes it from the card, exactly like an `UPDATE` of a database row. `action: 'save'` upserts: it writes to the `routecraft.carddav.url` header when present, otherwise creates. `'create'` always inserts (injecting a `UID` if absent). `'update'` writes to that url header and raises `RC5014` if none is resolvable, so read the card first (the read sets the url/etag headers). Update and delete send the read-time `routecraft.carddav.etag` header as an `If-Match` precondition, so a concurrent change on the server surfaces as a non-retryable conflict (`RC5030`) instead of silently overwriting.

```ts
// Read a card, edit one property, write it back. Everything else is preserved.
craft()
  .id('add-birthday')
  .from(carddav())
  .transform((body) => VCard.wrap(body).set('BDAY', '1990-05-21').data)
  .to(carddav({ action: 'update' }))
```

**Delete (`.to()`):** `action: 'delete'` removes the contact resolved from the read headers (`routecraft.carddav.url`/`uid`), the body's `UID`, or a custom `target` extractor. Returns `CardDAVDeleteResult`. No match raises `RC5014`.

```ts
craft()
  .from(carddav())
  .filter((body) => isStale(VCard.wrap(body)))
  .to(carddav({ action: 'delete' }))   // url comes from the read headers

// Or resolve the target explicitly:
.to(carddav({ action: 'delete', target: (ex) => ({ url: myUrlFor(ex) }) }))
```

**Options:**

| Field | Type | Description |
|-------|------|-------------|
| `account` | `string?` | Named account from context config (default account if omitted) |
| `addressBook` | `string?` | Address book display name (account/context default, else the first book) |
| `action` | `'save' \| 'create' \| 'update' \| 'delete'?` | Destination role. Absent = read (`.from`/`.enrich`) |
| `limit` | `number?` | Read only: maximum number of contacts |
| `target` | `(ex) => { url?, uid? }?` | Write/delete: resolve the target when the body lacks `uid`/`url` |
| `description` | `string?` | Human-readable description for route discovery |
| `keywords` | `string[]?` | Keywords for route discovery |

## The `VCard` document

The body is a plain `VCardBody`: a `version` and an ordered list of properties (`{ name, group?, params, value }`, where `value` is the escaped wire form). It is just data, so it survives `structuredClone`, `JSON.stringify`, queues, and `tap` with nothing lost. There is no typed `Contact` projection; because the body *is* the protocol, a read never silently drops data, and a write persists exactly what you hand back. Line order, parameter-name casing, and escaping in the output are canonical, not byte-identical to the input, but nothing is lost.

Wrap a body in a `VCard` for ergonomic reads and edits. The wrapper edits the underlying data in place; `.data` gives the plain body back.

```ts
import { VCard } from '@routecraft/routecraft'

const card = VCard.parse(rawVCardString)   // a wrapper; .data is the plain body
//   VCard.wrap(body)    — wrap a body the source emitted
//   VCard.create()      — start a fresh, empty card

card.text('FN')                 // "Jane Q Doe"  (decoded value of the first FN)
card.uid                        // "ABC-123"     (= text('UID'))
card.get('TEL')                 // every TEL property (views)
card.first('EMAIL')?.param('type')          // first TYPE param value
card.first('N')?.components()   // ['Doe','Jane','Q','','']  (structured value split)

card.set('NOTE', 'synced from CRM')         // replace all NOTE with one
card.add('TEL', '+15551234567', { params: [{ name: 'type', value: 'work' }] })
card.remove('X-CUSTOM-FIELD')   // drop a property entirely

card.data                       // the plain VCardBody to put on the exchange
card.toString()                 // serialize to wire form
```

**`VCard`** (wrapper)

| Member | Type | Description |
|--------|------|-------------|
| `VCard.wrap(body)` | `VCard` | Wrap a plain body (edits write through) |
| `VCard.create(version?)` | `VCard` | Wrapper over a fresh, empty body |
| `VCard.parse(raw)` / `parseVCard(raw)` | `VCard` | Parse a single card (throws on a collection) |
| `VCard.serialize(body)` | `string` | Serialize a plain body |
| `data` | `VCardBody` | The underlying plain body |
| `version` | `string` | vCard version (default `"3.0"`) |
| `uid` | `string?` (get/set) | Shortcut for `UID` |
| `get(name)` / `first(name)` | `VCardProperty[]` / `VCardProperty?` | Lookup by name (case-insensitive) |
| `text(name)` / `values(name)` | `string?` / `string[]` | Decoded value(s) of a property |
| `set` / `add` / `remove` | `this` | Replace-all / append / delete by name |
| `clone()` | `VCard` | Deep, independent copy |
| `toString()` | `string` | Serialize `.data` |

**`VCardProperty`** (a view over one property) `{ name, group?, params, value, raw, components(sep?), setComponents(parts, sep?), param(name) }` — `value` is the decoded text (escapes resolved); `raw` is the escaped wire value; `components()` splits a structured value (`N`, `ADR`, `ORG`) on unescaped separators. `params` is `{ name, value }[]`, preserved verbatim.

**Bring your own type.** If you want a typed shape, derive it in a `.transform()` and validate with your schema of choice, the same way you would with JSON from an HTTP endpoint:

```ts
.from(carddav())
.transform((body) => {
  const card = VCard.wrap(body)
  return { uid: card.uid, name: card.text('FN'), emails: card.values('EMAIL') }
})
```

**Exchange headers** on read: `routecraft.carddav.url`, `routecraft.carddav.uid`, `routecraft.carddav.etag`, `routecraft.carddav.account`. These carry the DAV identity used to target updates and deletes.

**Known names:** `VCARD` and `VPARAM` are convenience constants for the standard vCard property and parameter names (e.g. `card.text(VCARD.FN)`), with `KnownProperty` / `KnownParam` union types. They are values for autocomplete and typo-safety, not a constraint: every method still accepts an arbitrary `string`, so any property works.

**Exports:** `VCard`, `VCardProperty`, `parseVCard`, `VCARD`, `VPARAM` (values); `VCardBody`, `VCardPropertyData`, `CardDAVOptions`, `CardDAVReadOptions`, `CardDAVWriteOptions`, `CardDAVDeleteOptions`, `CardDAVContextConfig`, `CardDAVAccountConfig`, `CardDAVAction`, `CardDAVTargetExtractor`, `CardDAVWriteResult`, `CardDAVDeleteResult`, `VCardParam`, `VCardPropertyOptions`, `KnownProperty`, `KnownParam`, `CardDAVClientManager`, `CARDDAV_CLIENT_MANAGER` (types).
