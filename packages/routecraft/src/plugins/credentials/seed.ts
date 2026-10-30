import { rcError } from "../../error.ts";
import { CREDENTIALS_KEY_ENV, type CredentialSealer } from "./seal.ts";
import type { CredentialStore } from "./types.ts";

/**
 * Environment variable holding an encrypted seed: credentials obtained by
 * `craft connect --export` on a machine with a browser, imported by a
 * server on boot.
 */
export const CREDENTIALS_SEED_ENV = "ROUTECRAFT_CREDENTIALS_SEED";

const SEED_PREFIX = "rcseed1.";
const SEED_CONTEXT = "seed";

/** One credential carried by a seed. */
export interface CredentialSeedEntry {
  readonly owner: string;
  readonly value: unknown;
  /** When the login that produced it happened, in epoch milliseconds. */
  readonly issuedAt: number;
}

/**
 * Seal credentials into a seed. Always sealed, because a seed travels
 * between machines and through a secret manager.
 */
export function encodeCredentialSeed(
  entries: readonly CredentialSeedEntry[],
  sealer: CredentialSealer,
): string {
  const payload = JSON.stringify({ v: 1, entries });
  return `${SEED_PREFIX}${sealer.seal(payload, SEED_CONTEXT)}`;
}

/**
 * Open a seed.
 *
 * @throws RC5070 when it is malformed, or sealed under another key
 */
export function decodeCredentialSeed(
  seed: string,
  sealer: CredentialSealer | undefined,
): CredentialSeedEntry[] {
  const trimmed = seed.trim();
  if (!trimmed.startsWith(SEED_PREFIX)) {
    throw rcError("RC5070", undefined, {
      message: `${CREDENTIALS_SEED_ENV} is not a credential seed. Set it to the output of \`craft connect <client> --export\`, whole.`,
    });
  }
  if (!sealer) {
    throw rcError("RC5070", undefined, {
      message: `${CREDENTIALS_SEED_ENV} is set, and ${CREDENTIALS_KEY_ENV} is not. A seed is sealed; set the key it was exported under.`,
    });
  }
  const opened = sealer.open(trimmed.slice(SEED_PREFIX.length), SEED_CONTEXT);
  let payload: { v?: unknown; entries?: unknown };
  try {
    payload = JSON.parse(opened) as typeof payload;
  } catch (cause) {
    throw damaged(cause);
  }
  // Every entry or none: a seed that imports partly leaves some clients
  // without a credential while looking applied.
  if (
    payload?.v !== 1 ||
    !Array.isArray(payload.entries) ||
    !payload.entries.every(isSeedEntry)
  ) {
    throw damaged();
  }
  return payload.entries;
}

function damaged(cause?: unknown): Error {
  return rcError("RC5070", cause, {
    message: `${CREDENTIALS_SEED_ENV} was written by a newer build, or is damaged. Export it again with \`craft connect <client> --export\`.`,
  });
}

/**
 * Write a seed's credentials into the store, each only when the store holds
 * none for that owner or holds one from an earlier login. A credential the
 * server has refreshed since the seed was imported keeps its `issuedAt`, so
 * the same seed is never imported twice over a newer refresh token.
 *
 * @returns The owners written, and the owners left as they were
 */
export async function importCredentialSeed(
  store: CredentialStore,
  entries: readonly CredentialSeedEntry[],
): Promise<{ imported: string[]; kept: string[] }> {
  const imported: string[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    let current = await store.get(entry.owner);
    for (;;) {
      if (current !== undefined && current.issuedAt >= entry.issuedAt) {
        kept.push(entry.owner);
        break;
      }
      const write = await store.put(entry.owner, entry.value, {
        ifVersion: current?.version ?? null,
        issuedAt: entry.issuedAt,
      });
      if (write.written) {
        imported.push(entry.owner);
        break;
      }
      // Another replica wrote first. A refresh keeps the older login time,
      // so compare again against what it wrote rather than assume it won.
      current = write.current;
    }
  }
  return { imported, kept };
}

function isSeedEntry(value: unknown): value is CredentialSeedEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["owner"] === "string" &&
    typeof entry["issuedAt"] === "number" &&
    "value" in entry
  );
}
