// One place where a staff username's shape is written down.
//
// The binding gate is the database: migration 268's `username_format` CHECK is
// `username ~ '^[a-z][a-z0-9_-]{2,31}$'` — 3 to 32 characters, must start with a
// lowercase letter. The column is CITEXT, so uniqueness is case-insensitive, but
// the CHECK rejects uppercase outright: every surface that accepts a username
// must lower-case it rather than merely trim it.
//
// This literal used to be duplicated bare in four unrelated files, which is
// exactly the kind of drift that ships a login form the DB then rejects. It is
// mirrored once more on the server (`backend/src/services/users/setup.js`), which
// cannot import from here.
//
// TWO KINDS OF CONSUMER, and they need different things:
//   - JS validation (zod `.regex()`, `.test()`) takes the RegExp itself.
//   - An HTML `pattern=` attribute takes a STRING, so it takes `.source`.
// `.source` is `^[a-z][a-z0-9_-]{2,31}$`. A trailing hyphen inside a character
// class is a literal hyphen in both the JS regex grammar and the HTML `pattern`
// grammar, so the two are equivalent — the escaped `\-` those attributes used to
// carry was never load-bearing. HTML `pattern` is implicitly anchored and
// tolerates the explicit `^`/`$`.
//
// Deliberately NOT used for three nearby-looking things:
//   - the `.replace(/[^a-z0-9_-]/g, '')` input sanitisers (a strip-set, not an
//     anchored shape — an anchored regex cannot express it);
//   - `institutions.shortname` (its own domain, its own 23-char in-house-BB cap);
//   - an invite's `username_suffix` (`^[a-z0-9][a-z0-9_-]{0,19}$` — starts
//     alphanumeric, 1 to 20 chars, a genuinely different rule).

/** Staff username shape, mirroring migration 268's `username_format` CHECK. */
export const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

/** Normalise a typed username the way the DB expects it: trimmed, lower-cased. */
export function normaliseUsername(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** True when `raw`, once normalised, satisfies the CHECK. */
export function isValidUsername(raw) {
  return USERNAME_RE.test(normaliseUsername(raw));
}
