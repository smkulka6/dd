const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');

/**
 * In-memory limits suit a single server instance. When running more than one
 * instance, switch these to a shared store (e.g. rate-limit-redis).
 */
const make = (windowMs, limit, message, keyGenerator) =>
  rateLimit({
    windowMs,
    limit: env.isTest ? 10000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: message },
    ...(keyGenerator ? { keyGenerator } : {}),
  });

const loginKey = (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.email || req.body?.username || '').toLowerCase()}`;

module.exports = {
  globalLimiter: make(60 * 1000, 300, 'Too many requests. Please slow down.'),
  loginLimiter: make(15 * 60 * 1000, 10, 'Too many login attempts. Try again in 15 minutes.', loginKey),
  signupLimiter: make(60 * 60 * 1000, 10, 'Too many sign-ups from this network. Try again later.'),
  bookingLimiter: make(60 * 60 * 1000, 30, 'Too many booking requests. Try again later.'),
  enquiryLimiter: make(60 * 60 * 1000, 10, 'Too many enquiries. Try again later.'),
  aiLimiter: make(60 * 60 * 1000, 30, 'AI assistant limit reached. Try again later.'),
};
