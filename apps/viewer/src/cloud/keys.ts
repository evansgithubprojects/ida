/** Length of everything after `ida_` in an ingest key: the 12-hex prefix, `_`, and the 32-character secret; see apps/server/src/keys.ts. */
const KEY_BODY_LENGTH = 12 + 1 + 32;

/** What the key list shows for a stored key: `ida_` and then the whole rest masked, so the table doesn't hint at the key. */
export const maskKey = (): string => `ida_${'•'.repeat(KEY_BODY_LENGTH)}`;
