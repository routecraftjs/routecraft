import { port } from "../../kernel/port.ts";

import type {
  CredentialStore,
  CredentialWrite,
  StoredCredential,
} from "../../kernel/credentials.ts";

export type { CredentialStore, CredentialWrite, StoredCredential };

/**
 * The credential store, provided by the shipped credentials plugin and
 * replaceable by a plugin backed by a vault or a shared database.
 */
export const CREDENTIALS = port<CredentialStore>("routecraft.credentials@1");
