/**
 * Well-known vCard property and parameter names.
 *
 * A convenience catalog of the standardized vocabulary (RFC 6350 plus the common
 * Apple `X-` extensions), NOT a constraint: every {@link VCard} method accepts an
 * arbitrary `string`, so any property name (including ones not listed here) still
 * works. Use these for autocomplete and typo-safety on the names you know.
 *
 * @experimental
 */

/** Well-known vCard property names (RFC 6350 and common Apple extensions). */
export const VCARD = {
  /** Formatted display name (`FN`). Mandatory in a vCard. */
  FN: "FN",
  /** Structured name: `family;given;additional;prefixes;suffixes` (`N`). */
  N: "N",
  /** Nickname(s) (`NICKNAME`). */
  NICKNAME: "NICKNAME",
  /** Organization: `org;unit1;unit2` (`ORG`). */
  ORG: "ORG",
  /** Job title (`TITLE`). */
  TITLE: "TITLE",
  /** Telephone number (`TEL`). */
  TEL: "TEL",
  /** Email address (`EMAIL`). */
  EMAIL: "EMAIL",
  /** Structured postal address (`ADR`). */
  ADR: "ADR",
  /** Associated URL (`URL`). */
  URL: "URL",
  /** Instant-messaging handle (`IMPP`). */
  IMPP: "IMPP",
  /** Birthday (`BDAY`). */
  BDAY: "BDAY",
  /** Free-form note (`NOTE`). */
  NOTE: "NOTE",
  /** Photo, inline base64 or a URI (`PHOTO`). */
  PHOTO: "PHOTO",
  /** Tags / groups, comma-separated (`CATEGORIES`). */
  CATEGORIES: "CATEGORIES",
  /** Stable unique identifier (`UID`). */
  UID: "UID",
  /** Revision timestamp (`REV`). */
  REV: "REV",
  /** Product identifier of the authoring application (`PRODID`). */
  PRODID: "PRODID",
  /** Social-media profile, iCloud extension (`X-SOCIALPROFILE`). */
  X_SOCIALPROFILE: "X-SOCIALPROFILE",
  /** IM service name, iCloud extension (`X-SERVICE-TYPE`). */
  X_SERVICE_TYPE: "X-SERVICE-TYPE",
  /** Custom label for a grouped property, iCloud extension (`X-ABLabel`). */
  X_ABLABEL: "X-ABLabel",
  /** Labeled custom date such as an anniversary, iCloud extension (`X-ABDATE`). */
  X_ABDATE: "X-ABDATE",
  /** Labeled related person, iCloud extension (`X-ABRELATEDNAMES`). */
  X_ABRELATEDNAMES: "X-ABRELATEDNAMES",
} as const;

/** Well-known vCard parameter names (lowercased, matching the parsed form). */
export const VPARAM = {
  /** Property kind/label, e.g. `home`, `work`, `cell` (`TYPE`). */
  TYPE: "type",
  /** Value-type override, e.g. `uri` (`VALUE`). */
  VALUE: "value",
  /** Inline binary encoding, e.g. `b` for base64 (`ENCODING`). */
  ENCODING: "encoding",
} as const;

/** Union of the well-known property names in {@link VCARD}. */
export type KnownProperty = (typeof VCARD)[keyof typeof VCARD];

/** Union of the well-known parameter names in {@link VPARAM}. */
export type KnownParam = (typeof VPARAM)[keyof typeof VPARAM];
