const express = require('express');
require('express-async-errors'); // patches Express 4 to forward async errors to the error handler
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const logger = require('./config/logger');
const { sanitizeInput } = require('./middleware/sanitize');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const onboardingRouter = require('./routes/onboarding');
const institutionsRouter = require('./routes/institutions');
const donorsRouter = require('./routes/donors');
const donationsRouter = require('./routes/donations');
const inventoryRouter = require('./routes/inventory');
const requestsRouter = require('./routes/requests');
const coordinatorRouter = require('./routes/coordinator');
const lookbackRouter = require('./routes/lookback');
const webhooksRouter = require('./routes/webhooks');
const adminRouter = require('./routes/admin');
const reportsRouter = require('./routes/reports');
const geographyRouter = require('./routes/geography');
const campsRouter = require('./routes/camps');
const registriesRouter = require('./routes/registries');
const dhoRouter = require('./routes/dho');
const communityLeaderRouter = require('./routes/communityLeader');
const donorAlertsRouter = require('./routes/donorAlerts');
const hospitalRouter = require('./routes/hospital');
const vendorWebhooksRouter = require('./routes/vendor-webhooks');
const consentRouter = require('./routes/consent');

// Spec §10 security hardening:
//   - Helmet with a strict CSP (no inline scripts; API only serves JSON)
//   - CORS whitelist from env.allowedOrigins (FRONTEND_URL + comma-extra)
//   - Global rate limit: 100 req / IP / minute on the whole API surface
//   - sanitizeInput on every request body / query / params before route handlers
//
// Per-route rate limits (e.g. OTP send, institutional login) live in the
// route files and stack with the global limit.
function buildAllowedOrigins() {
  const extras = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([env.frontendUrl, ...extras]));
}

function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Trust the first proxy hop (load balancer / nginx) so req.ip reflects the
  // real client and express-rate-limit keys correctly. In dev with no proxy
  // this is a no-op.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // CSP for an API server: no scripts, no styles, no images. We're not
      // serving HTML — anything trying to render this response in a browser
      // shouldn't be running script.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  const allowedOrigins = buildAllowedOrigins();
  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow same-origin / curl (no Origin header) + whitelisted origins.
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`origin_not_allowed: ${origin}`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    }),
  );

  // Capture the raw request body buffer during JSON parsing so the
  // WhatsApp webhook can verify Meta's X-Hub-Signature-256 HMAC against
  // the exact bytes Meta signed. JSON.stringify(req.body) won't work —
  // key ordering and whitespace differ and the HMAC mismatches.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        // Only attach for routes that need it; on other routes this is
        // a tiny no-cost Buffer pointer that gets GC'd with the request.
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Global rate limit: 100 req/IP/min. Spec §10.
  // The OTP-send and institutional-login limits in routes/auth.js stack
  // on top of this — callers that hit those limits don't bypass the global.
  //
  // Camp-day exemptions: /auth/otp/send and /donors/register are the two
  // routes 50+ donors from one WiFi will hit in the same minute at a camp.
  // Both have their own mobile-keyed limiter (see routes/auth.js +
  // routes/donors.js), which is a tighter + more accurate abuse ceiling
  // than IP anyway — so we skip the global for those paths rather than
  // trip camps on 100/min.
  const CAMP_EXEMPT_PATHS = new Set(['/auth/otp/send', '/donors/register']);
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.path === '/health' || CAMP_EXEMPT_PATHS.has(req.path),
    message: { error: 'rate_limit_global' },
  });
  app.use(globalLimiter);

  app.use(sanitizeInput);

  app.use((req, _res, next) => {
    req.log = logger.child({ method: req.method, path: req.path });
    next();
  });

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/onboarding', onboardingRouter);
  app.use('/institutions', institutionsRouter);
  app.use('/donors', donorsRouter);
  app.use('/donations', donationsRouter);
  app.use('/inventory', inventoryRouter);
  app.use('/requests', requestsRouter);
  app.use('/coordinator', coordinatorRouter);
  app.use('/lookback', lookbackRouter);
  // Vendor push webhooks (public REST contract) — mount BEFORE the generic
  // /webhooks router so /webhooks/v1/* matches these routes even though the
  // more general prefix also covers them.
  app.use('/webhooks/v1', vendorWebhooksRouter);
  app.use('/webhooks', webhooksRouter);
  app.use('/admin', adminRouter);
  app.use('/reports', reportsRouter);
  app.use('/geography', geographyRouter);
  app.use('/camps', campsRouter);
  app.use('/registries', registriesRouter);
  app.use('/dho', dhoRouter);
  app.use('/community-leader', communityLeaderRouter);
  app.use('/donor-alerts', donorAlertsRouter);
  app.use('/hospital', hospitalRouter);
  app.use('/consent', consentRouter);
  // Public community profile endpoint — sibling of /community-leader,
  // mounted under /community (singular) to keep the URL friendly for
  // sharing. Exported as publicRouter from the same file so we keep all
  // community-related routes in one module.
  app.use('/community', communityLeaderRouter.publicRouter);

  // Nothing matched. This says `route_not_found`, NOT `not_found`, and the
  // distinction is load-bearing: a dozen handlers answer a missing ROW with
  // `not_found`, so a shared code made "this endpoint does not exist" and "that
  // record is gone" render as the same sentence on screen. That cost a real
  // investigation. The frontend and the API deploy from one push but not at one
  // speed — the static web app finished ~65s ahead of the App Service on the
  // 2026-08-28 release — so for that minute a new button called a route the
  // running API did not have yet, and the operator was told to go back to the
  // register and re-open a record that was never missing. An unmatched route now
  // says so in its own words.
  app.use((_req, res) => {
    res.status(404).json({ error: 'route_not_found' });
  });

  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    const logFn = status >= 500 ? 'error' : 'warn';
    req.log?.[logFn](
      { err: err.message, status, stack: status >= 500 ? err.stack : undefined },
      'Request error',
    );
    // err.code (canonical machine code) > err.message (human, not safe for prod 500s) > 'internal_error'
    const errorCode = err.code || (status < 500 ? err.message : null) || 'internal_error';
    const body = { error: errorCode };
    if (err.detail) body.detail = err.detail;
    res.status(status).json(body);
  });

  return app;
}

module.exports = createApp;
