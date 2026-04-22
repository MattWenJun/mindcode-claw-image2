#!/usr/bin/env node

const fs = require('fs');

const DEFAULT_BASE_URL = process.env.CODEX_IMAGEGEN_BASE_URL || 'http://127.0.0.1:4312';
const DEFAULT_PROMPT = process.env.CODEX_IMAGEGEN_SMOKE_PROMPT || 'a minimal white image with a tiny black dot centered';
const DEFAULT_TIMEOUT_SEC = Number(process.env.CODEX_IMAGEGEN_SMOKE_TIMEOUT_SEC || 180);
const DEFAULT_MAX_WAIT_MS = Number(process.env.CODEX_IMAGEGEN_SMOKE_MAX_WAIT_MS || 4 * 60 * 1000);
const DEFAULT_POLL_INTERVAL_MS = Number(process.env.CODEX_IMAGEGEN_SMOKE_POLL_INTERVAL_MS || 3000);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`expected JSON from ${url}, got: ${text.slice(0, 400)}`);
  }
  return { response, json };
}

async function main() {
  const args = parseArgs(process.argv);
  const baseUrl = (args['base-url'] || DEFAULT_BASE_URL).replace(/\/$/, '');
  const prompt = args.prompt || DEFAULT_PROMPT;
  const timeoutSec = Number(args['timeout-sec'] || DEFAULT_TIMEOUT_SEC);
  const maxWaitMs = Number(args['max-wait-ms'] || DEFAULT_MAX_WAIT_MS);
  const pollIntervalMs = Number(args['poll-interval-ms'] || DEFAULT_POLL_INTERVAL_MS);

  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error('timeout-sec must be positive');
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) throw new Error('max-wait-ms must be positive');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('poll-interval-ms must be positive');

  const startedAt = Date.now();

  const health = await fetchJson(`${baseUrl}/health`);
  if (!health.response.ok || !health.json?.ok) {
    throw new Error(`health check failed: ${JSON.stringify(health.json, null, 2)}`);
  }

  const submit = await fetchJson(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, timeout_sec: timeoutSec }),
  });
  if (submit.response.status !== 202 || !submit.json?.job?.id) {
    throw new Error(`job submission failed: ${JSON.stringify(submit.json, null, 2)}`);
  }

  const jobId = submit.json.job.id;
  let finalJob = null;

  while (Date.now() - startedAt < maxWaitMs) {
    const poll = await fetchJson(`${baseUrl}/v1/jobs/${encodeURIComponent(jobId)}`);
    if (!poll.response.ok || !poll.json?.job) {
      throw new Error(`job polling failed: ${JSON.stringify(poll.json, null, 2)}`);
    }

    const job = poll.json.job;
    if (job.status === 'completed' || job.status === 'failed') {
      finalJob = job;
      break;
    }

    await sleep(pollIntervalMs);
  }

  if (!finalJob) throw new Error(`timed out waiting for job ${jobId} after ${maxWaitMs}ms`);
  if (finalJob.status !== 'completed') throw new Error(`job failed: ${JSON.stringify(finalJob, null, 2)}`);

  const outputPath = finalJob.result?.outputPath;
  if (!outputPath) throw new Error(`completed job missing outputPath: ${JSON.stringify(finalJob, null, 2)}`);
  if (!fs.existsSync(outputPath)) throw new Error(`artifact does not exist: ${outputPath}`);

  const stat = fs.statSync(outputPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`artifact is invalid: ${outputPath}`);

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    prompt,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    health: health.json,
    job: finalJob,
    artifact: { outputPath, size: stat.size },
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
