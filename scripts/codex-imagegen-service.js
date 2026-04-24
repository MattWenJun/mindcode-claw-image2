#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateImage, GENERATED_IMAGES_ROOT, DEFAULT_WORKDIR } = require('./codex-imagegen-worker');

const PORT = Number(process.env.CODEX_IMAGEGEN_PORT || 4312);
const ARTIFACT_ROOT = process.env.CODEX_IMAGEGEN_ARTIFACT_ROOT || '/tmp/codex-imagegen-service';
const JOB_TTL_MS = Number(process.env.CODEX_IMAGEGEN_JOB_TTL_MS || 60 * 60 * 1000);
const JOB_STATE_FILE = process.env.CODEX_IMAGEGEN_JOB_STATE_FILE || path.join(ARTIFACT_ROOT, 'jobs-state.json');
const FAST_TIMEOUT_MS = Number(process.env.CODEX_IMAGEGEN_FAST_TIMEOUT_MS || 10 * 60 * 1000);
const LONG_TIMEOUT_MS = Number(process.env.CODEX_IMAGEGEN_LONG_TIMEOUT_MS || 20 * 60 * 1000);

const jobs = new Map();
let queueTail = Promise.resolve();

function createServiceError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function normalizeError(error, fallbackStatusCode = 500) {
  if (error && error.code) {
    return {
      statusCode: error.statusCode || fallbackStatusCode,
      error: {
        code: error.code,
        message: error.message || String(error),
        details: error.details || null,
      },
    };
  }

  return {
    statusCode: fallbackStatusCode,
    error: {
      code: 'internal-error',
      message: error?.message || String(error),
      details: null,
    },
  };
}

function logEvent(level, event, details = {}) {
  const payload = { ts: new Date().toISOString(), level, event, ...details };
  const line = JSON.stringify(payload);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendError(res, error, fallbackStatusCode = 500) {
  const normalized = normalizeError(error, fallbackStatusCode);
  logEvent('warn', 'request_failed', { statusCode: normalized.statusCode, error: normalized.error });
  sendJson(res, normalized.statusCode, { ok: false, error: normalized.error });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(createServiceError(413, 'request-body-too-large', 'request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function resolveCommandPath(command) {
  const pathValue = process.env.PATH || '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function ensureWritableDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.accessSync(dirPath, fs.constants.W_OK);
}

function redactUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) parsed.username = 'REDACTED';
    if (parsed.password) parsed.password = 'REDACTED';
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

function redactHeaders(headers = {}) {
  const redacted = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower.includes('token') || lower.includes('secret') || lower.includes('key')) {
      redacted[key] = '<redacted>';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function publicCallback(callback) {
  if (!callback) return null;
  return {
    url: redactUrl(callback.url),
    events: callback.events,
    headers: redactHeaders(callback.headers),
    timeoutMs: callback.timeoutMs,
  };
}

function normalizeCallback(callback) {
  if (callback == null) return null;
  if (typeof callback !== 'object' || Array.isArray(callback)) {
    throw createServiceError(400, 'invalid-callback', 'callback must be an object');
  }
  if (typeof callback.url !== 'string' || !callback.url.trim()) {
    throw createServiceError(400, 'invalid-callback-url', 'callback.url is required');
  }

  let parsed;
  try {
    parsed = new URL(callback.url);
  } catch {
    throw createServiceError(400, 'invalid-callback-url', 'callback.url must be a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createServiceError(400, 'invalid-callback-url', 'callback.url must use http or https');
  }

  const rawEvents = Array.isArray(callback.events) && callback.events.length ? callback.events : ['completed'];
  const events = [...new Set(rawEvents.map(event => String(event).trim().toLowerCase()).filter(Boolean))];
  const allowedEvents = new Set(['completed', 'failed']);
  const invalidEvent = events.find(event => !allowedEvents.has(event));
  if (invalidEvent) {
    throw createServiceError(400, 'invalid-callback-events', 'callback.events may only contain completed or failed', { event: invalidEvent });
  }

  const headers = {};
  if (callback.headers != null) {
    if (typeof callback.headers !== 'object' || Array.isArray(callback.headers)) {
      throw createServiceError(400, 'invalid-callback-headers', 'callback.headers must be an object');
    }
    for (const [key, value] of Object.entries(callback.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) {
        throw createServiceError(400, 'invalid-callback-headers', 'callback header names must be valid HTTP token strings', { header: key });
      }
      headers[key] = String(value);
    }
  }

  const timeoutMs = callback.timeout_ms == null ? 5000 : Number(callback.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
    throw createServiceError(400, 'invalid-callback-timeout', 'callback.timeout_ms must be between 1 and 60000');
  }

  return { url: parsed.toString(), events, headers, timeoutMs };
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    images: Array.isArray(job.images) ? job.images : [],
    mode: job.mode,
    requestedMode: job.requestedMode,
    timeoutMs: job.timeoutMs,
    fastTimeoutMs: job.fastTimeoutMs || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    completedAtMs: job.completedAtMs || null,
    expiresAt: job.expiresAt || null,
    expiresAtMs: job.expiresAtMs || null,
    promotedAt: job.promotedAt || null,
    promotedFromJobId: job.promotedFromJobId || null,
    replacementJobId: job.replacementJobId || null,
    promotionReason: job.promotionReason || null,
    callback: publicCallback(job.callback),
    notificationStatus: job.notificationStatus || null,
    notificationAttempts: job.notificationAttempts || 0,
    notificationError: job.notificationError || null,
    notificationSentAt: job.notificationSentAt || null,
    notificationLastAttemptAt: job.notificationLastAttemptAt || null,
    error: job.error || null,
    result: job.result || null,
  };
}

function persistJobs() {
  ensureWritableDirectory(path.dirname(JOB_STATE_FILE));
  const tmpPath = `${JOB_STATE_FILE}.tmp`;
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    jobs: [...jobs.values()].map(serializeJob),
  };
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, JOB_STATE_FILE);
}

function finalizeRecoveredJob(job, code, message) {
  job.status = 'failed';
  job.completedAt = new Date().toISOString();
  job.completedAtMs = Date.now();
  job.expiresAtMs = job.completedAtMs + JOB_TTL_MS;
  job.expiresAt = new Date(job.expiresAtMs).toISOString();
  job.error = { code, message, details: null };
}

function loadPersistedJobs() {
  if (!fs.existsSync(JOB_STATE_FILE)) return;
  const raw = fs.readFileSync(JOB_STATE_FILE, 'utf8');
  if (!raw.trim()) return;

  const parsed = JSON.parse(raw);
  const storedJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const now = Date.now();

  for (const storedJob of storedJobs) {
    if (!storedJob?.id) continue;
    if (storedJob.expiresAtMs && storedJob.expiresAtMs <= now) continue;

    const job = {
      id: storedJob.id,
      status: storedJob.status || 'failed',
      prompt: storedJob.prompt || '',
      images: Array.isArray(storedJob.images) ? storedJob.images : [],
      mode: storedJob.mode || 'fast',
      requestedMode: storedJob.requestedMode || storedJob.mode || 'fast',
      timeoutMs: Number(storedJob.timeoutMs) || LONG_TIMEOUT_MS,
      fastTimeoutMs: Number(storedJob.fastTimeoutMs) || null,
      createdAt: storedJob.createdAt || new Date(now).toISOString(),
      startedAt: storedJob.startedAt || null,
      completedAt: storedJob.completedAt || null,
      completedAtMs: Number(storedJob.completedAtMs) || null,
      expiresAt: storedJob.expiresAt || null,
      expiresAtMs: Number(storedJob.expiresAtMs) || null,
      promotedAt: storedJob.promotedAt || null,
      promotedFromJobId: storedJob.promotedFromJobId || null,
      replacementJobId: storedJob.replacementJobId || null,
      promotionReason: storedJob.promotionReason || null,
      callback: null,
      notificationStatus: storedJob.notificationStatus || null,
      notificationAttempts: Number(storedJob.notificationAttempts) || 0,
      notificationError: storedJob.notificationError || null,
      notificationSentAt: storedJob.notificationSentAt || null,
      notificationLastAttemptAt: storedJob.notificationLastAttemptAt || null,
      error: storedJob.error || null,
      result: storedJob.result || null,
    };

    if (job.status === 'queued' || job.status === 'running') {
      finalizeRecoveredJob(job, 'service-restarted', 'job did not complete because the service restarted while it was queued or running');
    }

    jobs.set(job.id, job);
  }

  logEvent('info', 'jobs_state_loaded', { jobCount: jobs.size, stateFile: JOB_STATE_FILE });
}

function cleanupExpiredJobs(now = Date.now()) {
  let removed = 0;
  for (const [jobId, job] of jobs.entries()) {
    if (!job.expiresAtMs || job.expiresAtMs > now) continue;
    jobs.delete(jobId);
    removed += 1;
    logEvent('info', 'job_expired', { jobId, status: job.status, expiredAt: job.expiresAt });
  }
  if (removed > 0) persistJobs();
}

function countJobs() {
  return {
    queued: [...jobs.values()].filter(job => job.status === 'queued').length,
    running: [...jobs.values()].filter(job => job.status === 'running').length,
    completed: [...jobs.values()].filter(job => job.status === 'completed').length,
    failed: [...jobs.values()].filter(job => job.status === 'failed').length,
    promoted: [...jobs.values()].filter(job => job.status === 'promoted').length,
    total: jobs.size,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    images: Array.isArray(job.images) ? job.images : [],
    mode: job.mode,
    requestedMode: job.requestedMode,
    fastTimeoutMs: job.fastTimeoutMs || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    expiresAt: job.expiresAt || null,
    promotedAt: job.promotedAt || null,
    promotedFromJobId: job.promotedFromJobId || null,
    replacementJobId: job.replacementJobId || null,
    promotionReason: job.promotionReason || null,
    callback: publicCallback(job.callback),
    notificationStatus: job.notificationStatus || null,
    notificationAttempts: job.notificationAttempts || 0,
    notificationError: job.notificationError || null,
    notificationSentAt: job.notificationSentAt || null,
    notificationLastAttemptAt: job.notificationLastAttemptAt || null,
    error: job.error || null,
    result: job.result || null,
  };
}

function finalizeJob(job, patch) {
  job.status = patch.status;
  job.completedAt = new Date().toISOString();
  job.completedAtMs = Date.now();
  job.expiresAtMs = job.completedAtMs + JOB_TTL_MS;
  job.expiresAt = new Date(job.expiresAtMs).toISOString();
  job.error = patch.error || null;
  job.result = patch.result || null;
}

function createReplacementJob(job, reason) {
  return {
    id: crypto.randomUUID(),
    status: 'queued',
    prompt: job.prompt,
    images: Array.isArray(job.images) ? [...job.images] : [],
    mode: 'long',
    requestedMode: job.requestedMode,
    timeoutMs: LONG_TIMEOUT_MS,
    fastTimeoutMs: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    completedAtMs: null,
    expiresAt: null,
    expiresAtMs: null,
    promotedAt: null,
    promotedFromJobId: job.id,
    replacementJobId: null,
    promotionReason: reason,
    callback: job.callback || null,
    notificationStatus: null,
    notificationAttempts: 0,
    notificationError: null,
    notificationSentAt: null,
    notificationLastAttemptAt: null,
    result: null,
    error: null,
  };
}

function shouldPromoteToReplacement(job, error) {
  if (job.requestedMode !== 'fast' || job.mode !== 'fast') return false;
  if (!error) return false;
  if (error.code === 'codex-exec-fast-timeout-no-artifact') return true;
  if ((error.code === 'codex-exec-failed' || error.code === 'no-new-image-detected') && !error.details?.firstImageSeenPath) {
    return true;
  }
  return false;
}

function postCallback(callback, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(callback.url);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...callback.headers,
      },
      timeout: callback.timeoutMs,
    }, res => {
      let responseBody = '';
      res.on('data', chunk => {
        responseBody += chunk.toString();
        if (responseBody.length > 4096) responseBody = responseBody.slice(-4096);
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode });
          return;
        }
        reject(new Error(`callback returned HTTP ${res.statusCode}: ${responseBody.slice(0, 400)}`));
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`callback timed out after ${callback.timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function dispatchCallback(job) {
  if (!job.callback) return;
  if (!job.callback.events.includes(job.status)) return;

  job.notificationStatus = 'pending';
  job.notificationAttempts = (job.notificationAttempts || 0) + 1;
  job.notificationLastAttemptAt = new Date().toISOString();
  job.notificationError = null;
  persistJobs();

  const payload = {
    event: job.status,
    job: publicJob(job),
  };
  try {
    const result = await postCallback(job.callback, payload);
    job.notificationStatus = 'sent';
    job.notificationSentAt = new Date().toISOString();
    job.notificationError = null;
    persistJobs();
    logEvent('info', 'job_callback_sent', {
      jobId: job.id,
      status: job.status,
      callbackUrl: redactUrl(job.callback.url),
      statusCode: result.statusCode,
    });
  } catch (error) {
    job.notificationStatus = 'failed';
    job.notificationError = error.message || String(error);
    persistJobs();
    logEvent('warn', 'job_callback_failed', {
      jobId: job.id,
      status: job.status,
      callbackUrl: redactUrl(job.callback.url),
      error: job.notificationError,
    });
  }
}

function getHealthReport() {
  const checks = [];

  const codexPath = resolveCommandPath('codex');
  checks.push({ name: 'codex-command', ok: Boolean(codexPath), details: codexPath ? { path: codexPath } : null });

  let artifactRootError = null;
  try { ensureWritableDirectory(ARTIFACT_ROOT); } catch (error) { artifactRootError = error.message || String(error); }
  checks.push({ name: 'artifact-root-writable', ok: !artifactRootError, details: { path: ARTIFACT_ROOT, error: artifactRootError } });

  let generatedImagesError = null;
  try {
    const stat = fs.statSync(GENERATED_IMAGES_ROOT);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch (error) { generatedImagesError = error.message || String(error); }
  checks.push({ name: 'generated-images-root', ok: !generatedImagesError, details: { path: GENERATED_IMAGES_ROOT, error: generatedImagesError } });

  let workerWorkdirError = null;
  try {
    const stat = fs.statSync(DEFAULT_WORKDIR);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch (error) { workerWorkdirError = error.message || String(error); }
  checks.push({ name: 'worker-workdir', ok: !workerWorkdirError, details: { path: DEFAULT_WORKDIR, error: workerWorkdirError } });

  let jobStateFileError = null;
  try { ensureWritableDirectory(path.dirname(JOB_STATE_FILE)); } catch (error) { jobStateFileError = error.message || String(error); }
  checks.push({ name: 'job-state-path-writable', ok: !jobStateFileError, details: { path: JOB_STATE_FILE, error: jobStateFileError } });

  const ready = checks.every(check => check.ok);
  return {
    ok: ready,
    queue: countJobs(),
    config: {
      port: PORT,
      artifactRoot: ARTIFACT_ROOT,
      jobTtlMs: JOB_TTL_MS,
      jobStateFile: JOB_STATE_FILE,
      generatedImagesRoot: GENERATED_IMAGES_ROOT,
      workerWorkdir: DEFAULT_WORKDIR,
      fastTimeoutMs: FAST_TIMEOUT_MS,
      longTimeoutMs: LONG_TIMEOUT_MS,
    },
    checks,
  };
}

function enqueueJob(job) {
  queueTail = queueTail
    .catch(() => {})
    .then(async () => {
      cleanupExpiredJobs();
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      persistJobs();
      logEvent('info', 'job_started', {
        jobId: job.id,
        promptPreview: job.prompt.slice(0, 120),
        mode: job.mode,
        requestedMode: job.requestedMode,
        timeoutMs: job.timeoutMs,
      });

      const outputPath = path.join(ARTIFACT_ROOT, `${job.id}.png`);
      try {
        const result = await generateImage({
          prompt: job.prompt,
          outputPath,
          timeoutMs: job.timeoutMs,
          images: job.images || [],
          promoteTimeoutMs: job.mode === 'fast' ? (job.fastTimeoutMs || FAST_TIMEOUT_MS) : null,
          onPromote: info => {
            job.mode = 'long';
            job.promotedAt = new Date(info.promotedAtMs).toISOString();
            job.promotionReason = 'artifact-detected-after-fast-timeout';
            persistJobs();
            logEvent('info', 'job_promoted_in_place', {
              jobId: job.id,
              promotedAt: job.promotedAt,
              firstImageSeenPath: info.firstImageSeenPath,
              firstImageSeenElapsedMs: info.firstImageSeenElapsedMs,
            });
          },
        });
        finalizeJob(job, {
          status: 'completed',
          result: {
            outputPath: result.outputPath,
            sourceImagePath: result.sourceImagePath,
            size: result.size,
            elapsedSec: result.elapsedSec,
            timings: result.timings || null,
          },
        });
        persistJobs();
        logEvent('info', 'job_completed', {
          jobId: job.id,
          mode: job.mode,
          outputPath: result.outputPath,
          sourceImagePath: result.sourceImagePath,
          size: result.size,
          elapsedSec: result.elapsedSec,
          expiresAt: job.expiresAt,
        });
        await dispatchCallback(job);
      } catch (error) {
        const normalized = normalizeError(error, 500);
        if (shouldPromoteToReplacement(job, normalized.error)) {
          const replacement = createReplacementJob(job, normalized.error.code);
          job.mode = 'long';
          job.replacementJobId = replacement.id;
          job.promotionReason = normalized.error.code;
          finalizeJob(job, {
            status: 'promoted',
            result: { replacementJobId: replacement.id },
          });
          jobs.set(replacement.id, replacement);
          persistJobs();
          logEvent('warn', 'job_promoted_to_replacement', {
            jobId: job.id,
            replacementJobId: replacement.id,
            reason: normalized.error.code,
          });
          enqueueJob(replacement);
          return;
        }

        finalizeJob(job, { status: 'failed', error: normalized.error });
        persistJobs();
        logEvent('error', 'job_failed', { jobId: job.id, mode: job.mode, error: normalized.error, expiresAt: job.expiresAt });
        await dispatchCallback(job);
      }
    });
}

loadPersistedJobs();
cleanupExpiredJobs();

const server = http.createServer(async (req, res) => {
  try {
    cleanupExpiredJobs();

    if (req.method === 'GET' && req.url === '/health') {
      const report = getHealthReport();
      sendJson(res, report.ok ? 200 : 503, report);
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      const rawBody = await readRequestBody(req);
      let body;
      try { body = rawBody ? JSON.parse(rawBody) : {}; }
      catch { throw createServiceError(400, 'invalid-json', 'request body is not valid JSON'); }

      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) throw createServiceError(400, 'prompt-required', 'prompt is required');

      const images = Array.isArray(body.images)
        ? body.images.filter(img => typeof img === 'string' && img.trim())
        : [];
      const callback = normalizeCallback(body.callback);

      const requestedMode = body.mode == null ? 'fast' : String(body.mode).trim().toLowerCase();
      if (!['fast', 'long'].includes(requestedMode)) {
        throw createServiceError(400, 'invalid-mode', 'mode must be fast or long', { mode: body.mode });
      }

      const defaultTimeoutMs = requestedMode === 'long' ? LONG_TIMEOUT_MS : LONG_TIMEOUT_MS;
      const timeoutSec = body.timeout_sec == null ? defaultTimeoutMs / 1000 : Number(body.timeout_sec);
      const fastTimeoutSec = body.fast_timeout_sec == null ? null : Number(body.fast_timeout_sec);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
        throw createServiceError(400, 'invalid-timeout-sec', 'timeout_sec must be a positive number', { timeoutSec: body.timeout_sec });
      }
      if (fastTimeoutSec != null && (!Number.isFinite(fastTimeoutSec) || fastTimeoutSec <= 0)) {
        throw createServiceError(400, 'invalid-fast-timeout-sec', 'fast_timeout_sec must be a positive number', { fastTimeoutSec: body.fast_timeout_sec });
      }

      ensureWritableDirectory(ARTIFACT_ROOT);

      const job = {
        id: crypto.randomUUID(),
        status: 'queued',
        prompt,
        images,
        mode: requestedMode,
        requestedMode,
        timeoutMs: timeoutSec * 1000,
        fastTimeoutMs: requestedMode === 'fast' ? (fastTimeoutSec == null ? FAST_TIMEOUT_MS : fastTimeoutSec * 1000) : null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        completedAtMs: null,
        expiresAt: null,
        expiresAtMs: null,
        promotedAt: null,
        promotedFromJobId: null,
        replacementJobId: null,
        promotionReason: null,
        callback,
        notificationStatus: null,
        notificationAttempts: 0,
        notificationError: null,
        notificationSentAt: null,
        notificationLastAttemptAt: null,
        result: null,
        error: null,
      };

      jobs.set(job.id, job);
      persistJobs();
      logEvent('info', 'job_queued', {
        jobId: job.id,
        promptPreview: job.prompt.slice(0, 120),
        mode: job.mode,
        requestedMode: job.requestedMode,
        timeoutMs: job.timeoutMs,
      });
      enqueueJob(job);

      sendJson(res, 202, { ok: true, job: publicJob(job) });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/v1/jobs/')) {
      const jobId = decodeURIComponent(req.url.slice('/v1/jobs/'.length));
      const job = jobs.get(jobId);
      if (!job) throw createServiceError(404, 'job-not-found', 'job not found', { jobId });
      sendJson(res, 200, { ok: true, job: publicJob(job) });
      return;
    }

    throw createServiceError(404, 'not-found', 'route not found', { method: req.method, url: req.url });
  } catch (error) {
    sendError(res, error, 500);
  }
});

server.listen(PORT, () => {
  logEvent('info', 'service_started', {
    port: PORT,
    artifactRoot: ARTIFACT_ROOT,
    jobTtlMs: JOB_TTL_MS,
    jobStateFile: JOB_STATE_FILE,
    fastTimeoutMs: FAST_TIMEOUT_MS,
    longTimeoutMs: LONG_TIMEOUT_MS,
  });
});
