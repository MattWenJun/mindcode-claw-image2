#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateImage, GENERATED_IMAGES_ROOT, DEFAULT_WORKDIR } = require('./codex-imagegen-worker');

const PORT = Number(process.env.CODEX_IMAGEGEN_PORT || 4312);
const ARTIFACT_ROOT = process.env.CODEX_IMAGEGEN_ARTIFACT_ROOT || '/tmp/codex-imagegen-service';
const JOB_TTL_MS = Number(process.env.CODEX_IMAGEGEN_JOB_TTL_MS || 60 * 60 * 1000);
const JOB_STATE_FILE = process.env.CODEX_IMAGEGEN_JOB_STATE_FILE || path.join(ARTIFACT_ROOT, 'jobs-state.json');

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

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    timeoutMs: job.timeoutMs,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    completedAtMs: job.completedAtMs || null,
    expiresAt: job.expiresAt || null,
    expiresAtMs: job.expiresAtMs || null,
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
      timeoutMs: Number(storedJob.timeoutMs) || 300000,
      createdAt: storedJob.createdAt || new Date(now).toISOString(),
      startedAt: storedJob.startedAt || null,
      completedAt: storedJob.completedAt || null,
      completedAtMs: Number(storedJob.completedAtMs) || null,
      expiresAt: storedJob.expiresAt || null,
      expiresAtMs: Number(storedJob.expiresAtMs) || null,
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
    total: jobs.size,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    expiresAt: job.expiresAt || null,
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
      logEvent('info', 'job_started', { jobId: job.id, promptPreview: job.prompt.slice(0, 120), timeoutMs: job.timeoutMs });

      const outputPath = path.join(ARTIFACT_ROOT, `${job.id}.png`);
      try {
        const result = await generateImage({ prompt: job.prompt, outputPath, timeoutMs: job.timeoutMs });
        finalizeJob(job, {
          status: 'completed',
          result: {
            outputPath: result.outputPath,
            sourceImagePath: result.sourceImagePath,
            size: result.size,
            elapsedSec: result.elapsedSec,
          },
        });
        persistJobs();
        logEvent('info', 'job_completed', {
          jobId: job.id,
          outputPath: result.outputPath,
          sourceImagePath: result.sourceImagePath,
          size: result.size,
          elapsedSec: result.elapsedSec,
          expiresAt: job.expiresAt,
        });
      } catch (error) {
        const normalized = normalizeError(error, 500);
        finalizeJob(job, { status: 'failed', error: normalized.error });
        persistJobs();
        logEvent('error', 'job_failed', { jobId: job.id, error: normalized.error, expiresAt: job.expiresAt });
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

      const timeoutSec = body.timeout_sec == null ? 300 : Number(body.timeout_sec);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
        throw createServiceError(400, 'invalid-timeout-sec', 'timeout_sec must be a positive number', { timeoutSec: body.timeout_sec });
      }

      ensureWritableDirectory(ARTIFACT_ROOT);

      const job = {
        id: crypto.randomUUID(),
        status: 'queued',
        prompt,
        timeoutMs: timeoutSec * 1000,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        completedAtMs: null,
        expiresAt: null,
        expiresAtMs: null,
        result: null,
        error: null,
      };

      jobs.set(job.id, job);
      persistJobs();
      logEvent('info', 'job_queued', { jobId: job.id, promptPreview: job.prompt.slice(0, 120), timeoutMs: job.timeoutMs });
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
  });
});
