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

**Write (`.to()`):** a write serializes the whole `Contact` and replaces the card; it does not merge. Because reading is lossless (see below), a read-modify-write keeps every field you did not touch, and dropping a field from the contact removes it, exactly like an `UPDATE` of a database row. `action: 'save'` upserts: it writes to the contact's `url` when present, otherwise creates. `'create'` always inserts (generating a `uid` if absent). `'update'` writes to the contact's `url` and raises `RC5014` if none is resolvable, so read the contact first (it then carries its `url`/`etag`). Update and delete send the read-time `etag` as an `If-Match` precondition, so a concurrent change on the server surfaces as a conflict (`RC5001`) instead of silently overwriting.

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

**`Contact` (mapped fields):** `uid`, `url`, `etag`, `fullName`, `firstName`, `lastName`, `middleName`, `prefix`, `suffix`, `nickname`, `organization`, `department` (ORG 2nd component), `title`, `categories[]`, `phones[]`, `emails[]` (each `{ value, type?, label?, params? }`), `addresses[]` (with `extended` for the apartment/suite component), `urls[]`, `instantMessages[]` (`IMPP`, with optional `scheme`), `socialProfiles[]` (`X-SOCIALPROFILE`), `relatedNames[]` (`X-ABRELATEDNAMES`, `{ label, name }`), `birthday`, `dates[]` (labeled dates / anniversaries, `{ label, date }`), `note`, `photo` (`{ data, mediaType }`, base64), `custom[]` (anything else), and `raw` (the original vCard text). On read, `url`/`etag` round-trip the DAV object so updates target the right resource.

**Labeled dates:** beyond `birthday`, iCloud stores anniversaries and custom dates as grouped `X-ABDATE` + `X-ABLabel`. These read into and write from `dates: { label, date }[]`.

```ts
.transform((c) => ({ uid: c.uid, dates: [{ label: 'Anniversary', date: '2010-06-01' }] }))
.to(carddav({ action: 'save' }))
```

**Custom fields:** properties outside the mapped set (e.g. arbitrary `X-*` extension properties, plus standard-but-unmodeled ones such as `PRODID` and `REV`) read into `custom: { key, value, type?, group?, params? }[]` and write back from it verbatim. Because a write is a full replace, dropping an entry from `custom` removes that property from the card. (Mapped iCloud properties such as `IMPP`, `NICKNAME`, `CATEGORIES`, and `X-SOCIALPROFILE` surface on their own typed fields and are excluded from `custom[]`.)

**Data integrity (lossless read, full replace).** The contract is simple: a read never silently drops data, and a write persists exactly the contact you give it. Reading captures every wire parameter on each item verbatim (`params`), the extended-address ADR component (`extended`), Apple custom labels (`label`, the `X-ABLabel` sibling), and any unmodeled property (`custom`), so a parse-then-serialize round-trip preserves the card. Writing serializes the whole contact and replaces the card. There is no per-record diff engine and no hidden back-refs: to change a field you edit it on the contact (`phone.type = 'work'`); to remove one you drop it before saving. Line order and escaping in the output are canonical, not byte-identical to the input, but no data is lost.

`params` is authoritative on write, with the ergonomic `type` applied over the primary `TYPE` when both are set, so editing `type` works without touching `params`. To change other parameters, edit `params` directly.

**Exchange headers** on read: `routecraft.carddav.url`, `routecraft.carddav.uid`, `routecraft.carddav.etag`, `routecraft.carddav.account`.

**Exported types:** `CardDAVOptions`, `CardDAVReadOptions`, `CardDAVWriteOptions`, `CardDAVDeleteOptions`, `CardDAVContextConfig`, `CardDAVAccountConfig`, `CardDAVAction`, `CardDAVTargetExtractor`, `CardDAVWriteResult`, `CardDAVDeleteResult`, `Contact`, `ContactPhone`, `ContactEmail`, `ContactAddress`, `ContactPhoto`, `ContactDate`, `ContactField`, `ContactInstantMessage`, `ContactSocialProfile`, `ContactRelatedName`, `VCardParam`, `CardDAVClientManager`, `CARDDAV_CLIENT_MANAGER`. Helpers: `parseVCard`, `serializeContact`.
