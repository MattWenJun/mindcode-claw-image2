#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE_URL = process.env.CODEX_IMAGEGEN_BASE_URL || 'http://127.0.0.1:4312';
const LABEL = 'com.openclaw.codex-imagegen-service';
const TARGET_PLIST = path.join(os.homedir(), 'Library/LaunchAgents/com.openclaw.codex-imagegen-service.plist');
const REPO_ROOT = path.resolve(__dirname, '..');

function appendArgValue(args, key, value) {
  if (!(key in args)) {
    args[key] = value;
    return;
  }
  if (Array.isArray(args[key])) {
    args[key].push(value);
    return;
  }
  args[key] = [args[key], value];
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) appendArgValue(args, key, true);
    else {
      appendArgValue(args, key, next);
      i += 1;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/codex-imagegenctl.js <command> [options]\n\nCommands:\n  install                install/update launchd service\n  start                  launchctl bootstrap + kickstart\n  stop                   launchctl bootout\n  restart                restart service\n  status                 print launchctl status\n  health                 GET /health\n  submit --prompt TEXT   submit image generation job\n                         [--image /path ...] repeat --image for reference image(s)\n                         [--mode fast|long] [--timeout-sec 1200] [--fast-timeout-sec 600]\n                         [--wait] [--poll-interval-ms 3000]\n  job <job-id>           inspect job\n  resolve <job-id>       follow promoted jobs to the current final job\n  smoke                  run smoke test\n  logs [--err] [--follow] show launchd logs\n`);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', ...opts });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestJson(method, url, body = null) {
  const args = ['-sS', '-X', method, '-w', '\n%{http_code}', url];
  if (body != null) {
    args.push('-H', 'content-type: application/json', '-d', JSON.stringify(body));
  }

  const res = spawnSync('curl', args, { encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || 'curl request failed').trim());

  const output = res.stdout || '';
  const lastNewline = output.lastIndexOf('\n');
  if (lastNewline === -1) throw new Error(`invalid curl response from ${url}`);

  const bodyText = output.slice(0, lastNewline).trim();
  const statusCode = Number(output.slice(lastNewline + 1).trim());
  let json = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    throw new Error(`expected JSON from ${url}, got: ${bodyText.slice(0, 400)}`);
  }

  return {
    response: { ok: statusCode >= 200 && statusCode < 300, status: statusCode },
    json,
  };
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function ensureInstallScript() {
  const script = path.join(REPO_ROOT, 'scripts', 'install-macos-launchd.sh');
  if (!fs.existsSync(script)) {
    console.error('install script not found:', script);
    process.exit(1);
  }
  run('bash', [script]);
}

async function resolveFinalJob(baseUrl, jobId, pollIntervalMs = 0) {
  let currentJobId = jobId;
  while (true) {
    const poll = requestJson('GET', `${baseUrl}/v1/jobs/${encodeURIComponent(currentJobId)}`);
    if (!poll.response.ok || !poll.json?.job) {
      throw new Error(`job fetch failed: ${JSON.stringify(poll.json, null, 2)}`);
    }
    const job = poll.json.job;
    if (job.status === 'promoted' && job.replacementJobId) {
      currentJobId = job.replacementJobId;
      if (pollIntervalMs > 0) await sleep(pollIntervalMs);
      continue;
    }
    return job;
  }
}

async function waitForJob(baseUrl, jobId, pollIntervalMs) {
  let currentJobId = jobId;
  while (true) {
    const poll = requestJson('GET', `${baseUrl}/v1/jobs/${encodeURIComponent(currentJobId)}`);
    if (!poll.response.ok || !poll.json?.job) {
      throw new Error(`job polling failed: ${JSON.stringify(poll.json, null, 2)}`);
    }

    const job = poll.json.job;
    if (job.status === 'promoted' && job.replacementJobId) {
      currentJobId = job.replacementJobId;
      continue;
    }
    if (job.status === 'completed' || job.status === 'failed') {
      return job;
    }

    await sleep(pollIntervalMs);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const command = args._[0];
  const baseUrl = BASE_URL.replace(/\/$/, '');
  if (!command) {
    usage();
    process.exit(1);
  }

  if (command === 'install') {
    ensureInstallScript();
    return;
  }

  if (command === 'start') {
    run('launchctl', ['bootout', `gui/${process.getuid()}`, TARGET_PLIST]);
    run('launchctl', ['bootstrap', `gui/${process.getuid()}`, TARGET_PLIST]);
    run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]);
    return;
  }

  if (command === 'stop') {
    run('launchctl', ['bootout', `gui/${process.getuid()}`, TARGET_PLIST]);
    return;
  }

  if (command === 'restart') {
    run('launchctl', ['bootout', `gui/${process.getuid()}`, TARGET_PLIST]);
    run('launchctl', ['bootstrap', `gui/${process.getuid()}`, TARGET_PLIST]);
    run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]);
    return;
  }

  if (command === 'status') {
    run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]);
    return;
  }

  if (command === 'health') {
    printJson(requestJson('GET', `${baseUrl}/health`).json);
    return;
  }

  if (command === 'submit') {
    const prompt = typeof args.prompt === 'string' ? args.prompt : args._.slice(1).join(' ').trim();
    if (!prompt) {
      console.error('--prompt is required');
      process.exit(1);
    }
    const rawImages = args.image;
    const images = rawImages ? (Array.isArray(rawImages) ? rawImages : [rawImages]) : [];
    const mode = args.mode == null ? 'fast' : String(args.mode).trim().toLowerCase();
    if (!['fast', 'long'].includes(mode)) {
      throw new Error('mode must be fast or long');
    }
    const timeoutSec = args['timeout-sec'] == null ? 1200 : Number(args['timeout-sec']);
    const fastTimeoutSec = args['fast-timeout-sec'] == null ? null : Number(args['fast-timeout-sec']);
    const pollIntervalMs = args['poll-interval-ms'] == null ? 3000 : Number(args['poll-interval-ms']);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error('timeout-sec must be a positive number');
    if (fastTimeoutSec != null && (!Number.isFinite(fastTimeoutSec) || fastTimeoutSec <= 0)) {
      throw new Error('fast-timeout-sec must be a positive number');
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('poll-interval-ms must be a positive number');

    const submit = requestJson('POST', `${baseUrl}/v1/images/generations`, {
      prompt,
      images,
      mode,
      timeout_sec: timeoutSec,
      fast_timeout_sec: fastTimeoutSec,
    });

    const job = submit.json?.job;
    if (!submit.response.ok || !job?.id) {
      printJson(submit.json);
      process.exit(1);
    }

    if (args.wait) {
      const finalJob = await waitForJob(baseUrl, job.id, pollIntervalMs);
      printJson({ ok: true, job: finalJob });
      if (finalJob.status !== 'completed') process.exit(1);
      return;
    }

    printJson(submit.json);
    return;
  }

  if (command === 'job') {
    const jobId = args._[1];
    if (!jobId) {
      console.error('job id is required');
      process.exit(1);
    }
    printJson(requestJson('GET', `${baseUrl}/v1/jobs/${encodeURIComponent(jobId)}`).json);
    return;
  }

  if (command === 'resolve') {
    const jobId = args._[1];
    if (!jobId) {
      console.error('job id is required');
      process.exit(1);
    }
    const job = await resolveFinalJob(baseUrl, jobId);
    printJson({ ok: true, job });
    return;
  }

  if (command === 'smoke') {
    run('node', [path.join(REPO_ROOT, 'scripts', 'codex-imagegen-smoke-test.js')]);
    return;
  }

  if (command === 'logs') {
    const file = args.err ? '/tmp/codex-imagegen-service.launchd.err.log' : '/tmp/codex-imagegen-service.launchd.out.log';
    if (args.follow) run('tail', ['-f', file]);
    else run('tail', ['-n', '100', file]);
    return;
  }

  usage();
  process.exit(1);
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
