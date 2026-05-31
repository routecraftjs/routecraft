/**
 * Minimal ambient typings for the optional peer `vcf` (no bundled types).
 *
 * Covers only the surface the CardDAV vCard codec uses. The package is a
 * CommonJS module whose `module.exports` is the `vCard` constructor with static
 * members, so it is consumed via the default export.
 */
declare module "vcf" {
  /** A single vCard property (e.g. one `TEL` or `EMAIL` line). */
  export interface VCardProperty {
    /** The property value. For `N`/`ADR` this is a `;`-delimited string. */
    valueOf(): string;
    toString(version?: string): string;
    is(type: string): boolean;
    isEmpty(): boolean;
    clone(): VCardProperty;
    /** Grouping prefix (e.g. `item1`) when present. */
    group?: string;
    /** `TYPE` parameter; a string, or an array when multi-valued. */
    type?: string | string[];
    /** `ENCODING` parameter (e.g. `b` for base64 in vCard 3.0). */
    encoding?: string;
  }

  /** A parsed or constructed vCard. */
  export interface VCardInstance {
    /** vCard version string (e.g. `"3.0"`). */
    version?: string;
    /** Field name to property (or array of properties for repeated fields). */
    data: Record<string, VCardProperty | VCardProperty[]>;
    get(key: string): VCardProperty | VCardProperty[] | undefined;
    set(
      key: string,
      value: string,
      params?: Record<string, string>,
    ): VCardInstance;
    add(
      key: string,
      value: string,
      params?: Record<string, string>,
    ): VCardInstance;
    toString(version?: string): string;
  }

  export interface VCardConstructor {
    new (): VCardInstance;
    (): VCardInstance;
    /** Parse one or more vCards from text. */
    parse(value: string): VCardInstance[];
    versions: string[];
  }

  const vCard: VCardConstructor;
  export default vCard;
}
