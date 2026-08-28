#!/usr/bin/env node
/**
 * Fail the build when a WhatsApp send can never deliver.
 *
 * Why this exists
 * ---------------
 * A send is looked up as env.whatsapp.templates[templateType.toLowerCase()]
 * (whatsappCloudProvider.js). When that key is absent the provider logs a
 * warning, returns success:false, and the notification_log row still persists
 * as 'FA'. Nothing throws. Nothing 500s. The scheduler job that calls it
 * reports a clean run.
 *
 * That is exactly how three shipped camp reminders (CAMP_PRECHECK_2D,
 * CAMP_DAY_OF, CAMP_DONOR_THANKYOU) and two live camp sends (CAMP_LINK,
 * CAMP_ANNC) came to fire on schedule and deliver nothing for weeks. A
 * silent failure needs a loud gate, so this is the gate.
 *
 * What it checks
 * --------------
 *   FAIL   a templateType used in backend/src with no entry in the env.js
 *          templates map. That send is a guaranteed no-op.
 *   WARN   a templateType with an env entry but no explicit builder in
 *          TEMPLATE_HANDLERS. It falls through to the default handler, which
 *          stuffs Object.values(variables) into the body positionally. Fine
 *          for a body-only template (REM), WRONG for anything with a URL
 *          button -- the button variable goes missing and Meta rejects the
 *          send with a param mismatch.
 *   INFO   an env entry nothing calls. Harmless; usually a deprecated
 *          template kept so an old code path does not break.
 *
 * What it deliberately cannot check: whether Meta has actually APPROVED the
 * template behind the name, and in which languages. That is a Graph API fact,
 * not a repo fact. docs/Raktify_WhatsApp_Templates.md tracks it by hand.
 *
 * Usage:  node scripts/check_whatsapp_templates.js [--quiet]
 * Exit:   0 = no FAILs, 1 = at least one FAIL, 2 = could not read a source file
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "backend", "src");
const ENV_FILE = path.join(SRC, "config", "env.js");
const PROVIDER = path.join(
  SRC,
  "services",
  "notifications",
  "whatsappCloudProvider.js",
);
const QUIET = process.argv.includes("--quiet");

// Types that are known NOT to be templates. BOT_REPLY is a free-form session
// reply inside Meta's 24h customer-service window -- legal precisely because
// the bot only ever answers an incoming message -- and needs a text-message
// path in the provider, not a template. Tracked separately; see the plan's
// out-of-scope list. Anything added here needs a reason on the same line.
const NOT_TEMPLATES = new Set(["BOT_REPLY"]);

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error(`cannot read ${path.relative(ROOT, file)}: ${err.message}`);
    process.exit(2);
  }
}

/**
 * Keys of the TEMPLATE_HANDLERS object literal in the provider.
 *
 * Parsed from source rather than required, for two reasons: the provider
 * exports only { send, providerName } so the object is unreachable at
 * runtime, and requiring it would pull in config/env.js, which throws on a
 * machine with no .env -- exactly the CI box this is meant to run on.
 */
function handlerKeys(src) {
  const start = src.indexOf("const TEMPLATE_HANDLERS");
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  if (open === -1) return null;

  // Walk to the matching close brace. Depth counting is enough here: the
  // handler bodies contain no brace inside a string or a comment. If that ever
  // stops being true this returns a short list and the WARN count jumps, which
  // is visible rather than silent.
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const body = src.slice(open + 1, end);
  const keys = new Set();
  // Top-level keys only: an UPPER_SNAKE identifier at two-space indentation
  // followed by a colon. Nested object keys are lower-case or deeper-indented.
  const re = /^ {2}([A-Z][A-Z0-9_]*)\s*(?:\([^)]*\)\s*)?:/gm;
  let m;
  while ((m = re.exec(body)) !== null) keys.add(m[1]);
  return keys;
}

/**
 * Keys of the `templates: { ... }` map inside env.js's `whatsapp:` block.
 *
 * env.js holds TWO maps called `templates:` -- msg91's DLT ids and this one.
 * Anchoring on the first match parses the MSG91 block, reports 2 keys instead
 * of 19, and turns every send in the tree into a FAIL. Anchor on `whatsapp:`.
 */
function envTemplateKeys(src) {
  const block = src.indexOf("whatsapp: {");
  if (block === -1) return null;
  const start = src.indexOf("templates:", block);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = src.slice(open + 1, end);
  const keys = new Map(); // lower-cased key -> WHATSAPP_TEMPLATE_* env var
  const re = /^\s*([a-z][a-z0-9_]*)\s*:\s*optional\(\s*'([^']+)'/gm;
  let m;
  while ((m = re.exec(body)) !== null) keys.set(m[1], m[2]);
  return keys;
}

/** Every .js file under backend/src. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * Every templateType a send in backend/src can pass, as
 * Map<TYPE, ['routes/camps.js:2191', ...]>.
 *
 * Three shapes have to be caught, because all three are in the tree:
 *
 *   templateType: 'OTP'                       a plain literal
 *   templateType: TEMPLATE_TYPE               a module const (the 3 camp jobs)
 *   templateType = cond ? 'A' : 'B'           a ternary (camps.js bb-response)
 *
 * Missing the const form would have reported the three camp reminders as
 * uncalled; missing the ternary would have hidden CAMP_BB_ACCEPTED and
 * CAMP_BB_CHANGED entirely -- which are precisely the sends this gate exists
 * to catch. So: collect ALL upper-snake literals on the line, and resolve a
 * bare identifier against the file's own top-level string consts.
 */
function scanCallers(files) {
  const found = new Map();
  const add = (type, where) => {
    if (!found.has(type)) found.set(type, []);
    found.get(type).push(where);
  };

  for (const file of files) {
    const src = read(file);
    if (!src.includes("templateType")) continue;
    const rel = path.relative(ROOT, file).split(path.sep).join("/");

    // Top-level `const NAME = 'LITERAL';` in this file, for identifier resolution.
    const consts = new Map();
    const cre = /^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^']+)'/gm;
    let cm;
    while ((cm = cre.exec(src)) !== null) consts.set(cm[1], cm[2]);

    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      const idx = line.indexOf("templateType");
      if (idx === -1) return;
      // Skip prose. A comment mentioning a templateType is not a call site,
      // and camps.js has one.
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;

      // Drop comparison operands before collecting literals. On
      //   const templateType = response === 'AC' ? 'CAMP_BB_ACCEPTED' : ...
      // the 'AC' is the value being TESTED, not a template -- collecting it
      // reports a phantom `ac:` key as missing.
      const rhs = line.slice(idx).replace(/(?:===|!==|==|!=)\s*'[^']*'/g, "");
      const where = `${rel}:${i + 1}`;
      let matched = false;

      for (const m of rhs.matchAll(/'([A-Z][A-Z0-9_]*)'/g)) {
        add(m[1], where);
        matched = true;
      }
      if (matched) return;

      // Bare identifier: templateType: TEMPLATE_TYPE / templateType,
      const id = rhs.match(/templateType\s*[:=]\s*([A-Za-z_][A-Za-z0-9_]*)/);
      if (id && consts.has(id[1])) add(consts.get(id[1]), where);
      else if (id && /^[A-Z][A-Z0-9_]*$/.test(id[1]))
        add(`UNRESOLVED(${id[1]})`, where);
    });
  }
  return found;
}

// ── report ─────────────────────────────────────────────────────────────────

const providerSrc = read(PROVIDER);
const envSrc = read(ENV_FILE);

const handlers = handlerKeys(providerSrc);
const envKeys = envTemplateKeys(envSrc);

if (!handlers) {
  console.error(
    "could not locate TEMPLATE_HANDLERS in whatsappCloudProvider.js",
  );
  process.exit(2);
}
if (!envKeys) {
  console.error("could not locate the templates map in config/env.js");
  process.exit(2);
}

const callers = scanCallers(walk(SRC));
const fails = [];
const warns = [];
const skipped = [];

for (const type of [...callers.keys()].sort()) {
  const sites = callers.get(type);
  if (NOT_TEMPLATES.has(type)) {
    skipped.push({ type, sites });
    continue;
  }
  if (type.startsWith("UNRESOLVED(")) {
    // A templateType passed as a variable this script could not follow. Not a
    // proven failure, but it means the gate has a blind spot -- worth a warn.
    warns.push({
      type,
      sites,
      why: "templateType is a variable this check cannot resolve",
    });
    continue;
  }
  const key = type.toLowerCase();
  if (!envKeys.has(key)) {
    fails.push({
      type,
      sites,
      why: `no '${key}:' entry in env.js templates -- this send is a silent no-op`,
    });
    continue;
  }
  if (!handlers.has(type)) {
    warns.push({
      type,
      sites,
      why: "no explicit TEMPLATE_HANDLERS entry -- falls back to the default positional body builder, which is WRONG for any template with a URL button",
    });
  }
}

// Env keys nothing calls. Informational: usually a template kept so an older
// code path keeps working, occasionally a typo on the caller side.
const called = new Set([...callers.keys()].map((t) => t.toLowerCase()));
const unused = [...envKeys.keys()].filter((k) => !called.has(k)).sort();

if (!QUIET) {
  console.log(`WhatsApp template wiring check`);
  console.log(`  handlers in TEMPLATE_HANDLERS : ${handlers.size}`);
  console.log(`  env template keys             : ${envKeys.size}`);
  console.log(`  templateTypes used in src     : ${callers.size}`);
  console.log("");
}

for (const f of fails) {
  console.log(`FAIL  ${f.type}`);
  console.log(`      ${f.why}`);
  for (const s of f.sites) console.log(`      at ${s}`);
}
for (const w of warns) {
  console.log(`WARN  ${w.type}`);
  console.log(`      ${w.why}`);
  for (const s of w.sites) console.log(`      at ${s}`);
}
if (!QUIET) {
  for (const s of skipped) {
    console.log(
      `SKIP  ${s.type}  (on the NOT_TEMPLATES list -- needs a non-template path)`,
    );
    for (const at of s.sites) console.log(`      at ${at}`);
  }
  if (unused.length) {
    console.log(`INFO  env template keys nothing calls: ${unused.join(", ")}`);
  }
}

console.log("");
console.log(`${fails.length} fail, ${warns.length} warn`);
if (fails.length) {
  console.log("");
  console.log(
    "A FAIL means the provider will log a warning, return success:false,",
  );
  console.log(
    "write a notification_log row as 'FA', and deliver nothing -- without",
  );
  console.log(
    "throwing. Add the key to config/env.js and set WHATSAPP_TEMPLATE_* in",
  );
  console.log("Azure Key Vault (raktify-kv).");
}
process.exit(fails.length ? 1 : 0);
