-- 320_default_language_english.sql
--
-- preferred_language defaults to 'en', not 'mr', on all three tables that
-- carry it: donors (008:33), coordinators (006:24), community_leaders (271:35).
--
-- WHY. preferred_language is the WHATSAPP language, not the UI language (see
-- CLAUDE.md "Marathi i18n"). Every notification path reads it and passes it to
-- Meta as language.code. A 'mr' default therefore meant: any row created
-- WITHOUT an explicit answer got Marathi WhatsApp for good. That is wrong in
-- two directions --
--
--   1. It is a guess, not a preference. Donor registration ASKS now (c9a8c85),
--      but the vendor webhook, the admin bulk upload and the admin create form
--      do not, and neither does any future importer. A guessed Marathi
--      preference is indistinguishable from a chosen one afterwards.
--   2. It couples delivery to per-language Meta approval. A template APPROVED
--      in en but PENDING in mr is rejected outright for a defaulted row, so a
--      column default silently decided whether a message could be sent at all.
--      That is exactly what held the camp_day_of_v2 appsetting flip.
--
-- English is the safe default because every template in the WABA is approved
-- in en, and a donor who tells us they read Marathi still gets Marathi -- the
-- registration select, the profile editor and the admin forms all write an
-- explicit value that overrides this default.
--
-- EXISTING ROWS ARE DELIBERATELY NOT BACKFILLED. A stored 'mr' cannot be told
-- apart from a chosen 'mr', and rewriting a real donor's stated preference to
-- English is the worse error. There is no delivery reason to: every camp and
-- donor template is now APPROVED in all three languages. This migration
-- changes only what NEW rows inherit.
--
-- ALTER COLUMN ... SET DEFAULT is a catalogue-only change in Postgres: no
-- table rewrite, no scan, no lock beyond a brief ACCESS EXCLUSIVE. Safe on a
-- live donors table of any size. The CHECK (mr|hi|en) is untouched.

ALTER TABLE donors            ALTER COLUMN preferred_language SET DEFAULT 'en';
ALTER TABLE coordinators      ALTER COLUMN preferred_language SET DEFAULT 'en';
ALTER TABLE community_leaders ALTER COLUMN preferred_language SET DEFAULT 'en';

-- ROLLBACK
-- ALTER TABLE donors            ALTER COLUMN preferred_language SET DEFAULT 'mr';
-- ALTER TABLE coordinators      ALTER COLUMN preferred_language SET DEFAULT 'mr';
-- ALTER TABLE community_leaders ALTER COLUMN preferred_language SET DEFAULT 'mr';
