/** Length of the secret part of an ingest key (`eda_<prefix>_<secret>`); see apps/server/src/keys.ts. */
const SECRET_LENGTH = 32;

/** What the key list shows for a stored key: the API's `prefix` is `eda_<hex>_`, and the secret that follows is masked. */
export const maskKey = (prefix: string): string => `${prefix}${'•'.repeat(SECRET_LENGTH)}`;
