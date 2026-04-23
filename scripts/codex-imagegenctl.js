#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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
  console.log(`Usage: node scripts/codex-imagegenctl.js <command> [options]\n\nCommands:\n  install                install/update launchd service\n  start                  launchctl bootstrap + kickstart\n  stop                   launchctl bootout\n  restart                restart service\n  status                 print launchctl status\n  health                 GET /health\n  submit --prompt TEXT   submit image generation job\n                         [--image /path ...] repeat --image for reference image(s)\n  job <job-id>           inspect job\n  smoke                  run smoke test\n  logs [--err] [--follow] show launchd logs\n`);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', ...opts });
}

function jsonFetch(url, options = {}) {
  const res = spawnSync('curl', ['-sS', ...(options.method ? ['-X', options.method] : []), ...(options.headers || []).flatMap(h => ['-H', h]), ...(options.data ? ['--data-binary', options.data] : []), url], { encoding: 'utf8' });
  if (res.status !== 0) process.exit(res.status || 1);
  process.stdout.write(res.stdout);
}

function ensureInstallScript() {
  const script = path.join(REPO_ROOT, 'scripts', 'install-macos-launchd.sh');
  if (!fs.existsSync(script)) {
    console.error('install script not found:', script);
    process.exit(1);
  }
  run('bash', [script]);
}

function main() {
  const args = parseArgs(process.argv);
  const command = args._[0];
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
    jsonFetch(`${BASE_URL}/health`);
    return;
  }

  if (command === 'submit') {
    const prompt = args.prompt;
    if (!prompt) {
      console.error('--prompt is required');
      process.exit(1);
    }
    const rawImages = args.image;
    const images = rawImages ? (Array.isArray(rawImages) ? rawImages : [rawImages]) : [];
    const payload = JSON.stringify({ prompt, images, timeout_sec: Number(args['timeout-sec'] || 180) });
    jsonFetch(`${BASE_URL}/v1/images/generations`, {
      method: 'POST',
      headers: ['content-type: application/json'],
      data: payload,
    });
    return;
  }

  if (command === 'job') {
    const jobId = args._[1];
    if (!jobId) {
      console.error('job id is required');
      process.exit(1);
    }
    jsonFetch(`${BASE_URL}/v1/jobs/${encodeURIComponent(jobId)}`);
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

main();
