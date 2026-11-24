const env = require('../config/env');
const OutboxJob = require('../models/OutboxJob');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 10;
const REQUEST_TIMEOUT_MS = 8000;

let timer = null;
let running = false;

/** Queue a Sheets/email sync job. Pass the transaction session to commit it atomically. */
const enqueue = async (type, payload, session) => {
  if (!env.GOOGLE_SHEET_WEBHOOK_URL) return null;
  const [job] = await OutboxJob.create([{ type, payload }], { session });
  return job;
};

const deliver = async (job) => {
  const res = await fetch(env.GOOGLE_SHEET_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: env.GOOGLE_SHEET_WEBHOOK_SECRET, action: job.type, job_id: job._id.toString(), ...job.payload }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  // Apps Script returns HTTP 200 even for script errors, so check the body too.
  if (!res.ok || !body || body.status !== 'success') {
    throw new Error(`Webhook rejected job: HTTP ${res.status} ${body?.message || text.slice(0, 120)}`);
  }
};

/** Claim and process due jobs one at a time. Safe to run on several instances. */
const processDueJobs = async (limit = 20) => {
  let processed = 0;
  while (processed < limit) {
    const now = new Date();
    const job = await OutboxJob.findOneAndUpdate(
      {
        $or: [
          { status: 'pending', next_attempt_at: { $lte: now } },
          { status: 'processing', locked_until: { $lte: now } },
        ],
      },
      { $set: { status: 'processing', locked_until: new Date(now.getTime() + 60000) }, $inc: { attempts: 1 } },
      { new: true, sort: { next_attempt_at: 1 } }
    );
    if (!job) break;
    processed += 1;
    try {
      await deliver(job);
      job.status = 'done';
      job.last_error = undefined;
    } catch (err) {
      const backoff = Math.min(60 * 60 * 1000, 30000 * 2 ** (job.attempts - 1));
      job.status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      job.next_attempt_at = new Date(Date.now() + backoff);
      job.last_error = err.message.slice(0, 500);
      logger.warn(`[outbox] job ${job._id} (${job.type}) attempt ${job.attempts} failed: ${job.last_error}`);
    }
    job.locked_until = undefined;
    await job.save();
  }
  return processed;
};

const start = () => {
  if (timer || !env.GOOGLE_SHEET_WEBHOOK_URL) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processDueJobs();
    } catch (err) {
      logger.error('[outbox] worker error', err.message);
    } finally {
      running = false;
    }
  }, env.OUTBOX_POLL_MS);
  timer.unref();
};

const stop = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

module.exports = { enqueue, processDueJobs, start, stop };
