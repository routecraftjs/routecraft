---
title: carddav
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
carddav(options?: CardDAVReadOptions): Source<Contact> & Destination<unknown, Contact[]>
carddav(options: CardDAVWriteOptions): Destination<Contact, CardDAVWriteResult>
carddav(options: CardDAVDeleteOptions): Destination<unknown, CardDAVDeleteResult>
```

Read and write contacts over CardDAV. Defaults to Apple iCloud Contacts (`https://contacts.icloud.com`) but works with any CardDAV server (Fastmail, Nextcloud, Google). The role is chosen by an `action` flag, the same way the mail adapter selects its mode: no `action` reads, `action` writes or deletes.

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

**Read (`.from()`):** no `action`. Emits one `Contact` per address-book entry. This is a one-shot fetch-all; pair it with a scheduler for periodic reads.

```ts
craft()
  .id('contacts-export')
  .from(carddav())
  .to(log())

craft().from(carddav({ account: 'work', addressBook: 'Colleagues', limit: 500 })).to(...)
```

**Read (`.enrich()`):** no `action`. Fetches all contacts and merges them onto the triggering exchange (the default aggregator spreads the array onto the body with numeric keys, as with `mail`).

```ts
craft()
  .from(cron('0 2 * * *'))
  .enrich(carddav())
  .to(writeCsv('contacts.csv'))
```

**Write (`.to()`):** `action: 'save'` upserts the exchange body (a `Contact`) by `uid`/`url`. Updates fetch the existing card and patch only the fields you provide, so untouched properties survive. Optimistic concurrency uses the ETag. `'create'` always inserts (generating a `uid` if absent); `'update'` requires a match (else `RC5014`).

```ts
// Set a birthday on an existing contact without touching other fields.
craft()
  .id('add-birthday')
  .from(direct())
  .to(carddav({ action: 'save' }))
```

**Delete (`.to()`):** `action: 'delete'` removes the contact resolved from the body (`uid`/`url`), the read headers (`routecraft.carddav.*`), or a custom `target` extractor. Returns `CardDAVDeleteResult`. No match raises `RC5014`.

```ts
craft()
  .from(carddav())
  .filter((c) => isStale(c))
  .to(carddav({ action: 'delete' }))

// Or resolve the target explicitly:
.to(carddav({ action: 'delete', target: (ex) => ({ url: ex.body.url }) }))
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

**`Contact` (mapped fields):** `uid`, `url`, `etag`, `fullName`, `firstName`, `lastName`, `middleName`, `prefix`, `suffix`, `nickname`, `organization`, `department` (ORG 2nd component), `title`, `categories[]`, `phones[]`, `emails[]`, `addresses[]`, `urls[]`, `instantMessages[]` (`IMPP`, with optional `scheme`), `socialProfiles[]` (`X-SOCIALPROFILE`), `relatedNames[]` (`X-ABRELATEDNAMES`, `{ label, name }`), `birthday`, `dates[]` (labeled dates / anniversaries, `{ label, date }`), `note`, `photo` (`{ data, mediaType }`, base64), `custom[]` (anything else), and `raw` (the original vCard text). On read, `url`/`etag` round-trip the DAV object so updates target the right resource.

**Labeled dates:** beyond `birthday`, iCloud stores anniversaries and custom dates as grouped `X-ABDATE` + `X-ABLabel`. These read into and write from `dates: { label, date }[]`.

```ts
.transform((c) => ({ uid: c.uid, dates: [{ label: 'Anniversary', date: '2010-06-01' }] }))
.to(carddav({ action: 'save' }))
```

**Custom fields:** properties outside the mapped set (e.g. arbitrary `X-*` extension properties) read into `custom: { key, value, type?, group? }[]` and write back from it. On `save`/`update` they upsert by key + group; custom fields you do not mention are left untouched. (Mapped iCloud properties such as `IMPP`, `NICKNAME`, `CATEGORIES`, and `X-SOCIALPROFILE` surface on their own typed fields and are excluded from `custom[]`.)

**Data integrity (per-record diff/merge).** Updates are applied as a per-record diff against the existing raw vCard: each item the read path returns carries a hidden back-ref to its source record (via a `WeakMap`), so on patch the merger rewrites only the bytes you changed inside that origin record. Every other parameter, the `item N.` group prefix, and any grouped `X-ABLabel` sibling survive byte-for-byte. Unmatched origins are removed (and only their `X-ABLabel` sibling along with them); new items are appended fresh just before `END:VCARD`. Anything the typed model does not surface is preserved by default — no model expansion needed when iCloud invents a new property.

**Editing items in route transforms.** Items returned from the read path carry their back-ref in a `WeakMap` keyed by object identity. A naked spread (`{...item, value: 'new'}`) creates a new object that the `WeakMap` does not recognise, so the merger falls back to value-equality matching — which fails when both the value AND the type change in the same edit, dropping the item's params and group. Use `withChanges(item, partial)` to thread the ref through an in-place edit:

```ts
import { withChanges } from '@routecraft/routecraft'

// Edit one address's city, preserving its `item1.` group, its X-ABLabel
// sibling, and any extended-address bytes the model does not expose.
const updated = parsed.addresses!.map((a) =>
  a.city === 'Springfield' ? withChanges(a, { city: 'Chicago' }) : a,
)

await craft().from(simple(updated)).to(carddav({ action: 'save' })).run()
```

Items constructed from scratch (`{ value: '+1...' }`) have no ref to preserve; the patcher falls back to value-equality matching for them.

**Exchange headers** on read: `routecraft.carddav.url`, `routecraft.carddav.uid`, `routecraft.carddav.etag`, `routecraft.carddav.account`.

**Exported types:** `CardDAVOptions`, `CardDAVReadOptions`, `CardDAVWriteOptions`, `CardDAVDeleteOptions`, `CardDAVContextConfig`, `CardDAVAccountConfig`, `CardDAVAction`, `CardDAVTargetExtractor`, `CardDAVWriteResult`, `CardDAVDeleteResult`, `Contact`, `ContactPhone`, `ContactEmail`, `ContactAddress`, `ContactPhoto`, `ContactDate`, `ContactField`, `ContactInstantMessage`, `ContactSocialProfile`, `ContactRelatedName`, `CardDAVClientManager`, `CARDDAV_CLIENT_MANAGER`. Helpers: `parseVCard`, `serializeContact`, `patchVCard`, `withChanges`.
