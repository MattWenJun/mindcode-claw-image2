#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const GENERATED_IMAGES_ROOT = path.join(os.homedir(), '.codex', 'generated_images');
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_WORKDIR = process.env.CODEX_IMAGEGEN_WORKDIR || path.resolve(__dirname, '..');

function createWorkerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.reason = code;
  error.details = details;
  return error;
}

function usage() {
  console.error('Usage: node scripts/codex-imagegen-worker.js "<prompt>" [--output /tmp/out.png] [--timeout-sec 300] [--workdir /path] [--image /path/to/ref.png ...]');
  process.exit(1);
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
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function buildImagegenPrompt(prompt) {
  return [
    'Use imagegen to create an image with this request:',
    prompt,
    '',
    'Requirements:',
    '- Generate the image directly',
    '- Do not provide explanation',
    '- Return only the image result',
  ].join('\n');
}

function snapshotPngFiles(rootDir) {
  const snapshot = new Map();
  if (!fs.existsSync(rootDir)) return snapshot;

  const pending = [rootDir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
      try {
        const stat = fs.statSync(fullPath);
        snapshot.set(fullPath, { mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }

  return snapshot;
}

function diffNewFiles(before, after) {
  const created = [];
  for (const [filePath, meta] of after.entries()) {
    const previous = before.get(filePath);
    if (!previous || previous.mtimeMs !== meta.mtimeMs || previous.size !== meta.size) {
      created.push({ path: filePath, ...meta });
    }
  }
  created.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return created;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function waitForStableSize(filePath, attempts = 3, delayMs = 500) {
  return new Promise((resolve, reject) => {
    let previousSize = -1;
    let stableCount = 0;
    let tries = 0;

    const tick = () => {
      tries += 1;
      let size;
      try {
        size = fs.statSync(filePath).size;
      } catch (error) {
        reject(error);
        return;
      }

      if (size === previousSize) stableCount += 1;
      else stableCount = 0;

      previousSize = size;
      if (stableCount >= attempts - 1 || tries >= attempts * 3) {
        resolve(size);
        return;
      }

      setTimeout(tick, delayMs);
    };

    tick();
  });
}

function runCodexExec({ workdir, prompt, timeoutMs, images }) {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--color',
      'never',
    ];

    if (Array.isArray(images) && images.length > 0) {
      for (const imagePath of images) {
        args.push('-i', imagePath);
      }
      args.push('--');
    }

    args.push(prompt);

    const child = spawn('codex', args, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(createWorkerError('codex-exec-spawn-failed', 'failed to launch codex exec', {
        cause: error.message || String(error),
      }));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        reject(createWorkerError('codex-exec-timeout', `codex exec timed out after ${timeoutMs}ms`, { timeoutMs }));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function generateImage(options) {
  const prompt = options.prompt;
  if (!prompt) throw createWorkerError('prompt-required', 'prompt is required');

  const workdir = path.resolve(options.workdir || DEFAULT_WORKDIR);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw createWorkerError('invalid-timeout-ms', 'timeoutMs must be a positive number', {
      timeoutMs: options.timeoutMs,
    });
  }

  const inputImages = Array.isArray(options.images) ? options.images : [];
  const images = inputImages.map(img => path.resolve(img));
  for (const imagePath of images) {
    if (!fs.existsSync(imagePath)) {
      throw createWorkerError('image-not-found', `image file not found: ${imagePath}`, { path: imagePath });
    }
  }

  const before = snapshotPngFiles(GENERATED_IMAGES_ROOT);
  const startedAt = Date.now();
  const execution = await runCodexExec({
    workdir,
    prompt: buildImagegenPrompt(prompt),
    timeoutMs,
    images,
  });
  const after = snapshotPngFiles(GENERATED_IMAGES_ROOT);
  const newFiles = diffNewFiles(before, after);

  if (execution.code !== 0) {
    throw createWorkerError('codex-exec-failed', 'codex exec exited with a non-zero status', {
      exitCode: execution.code,
      stdoutPreview: execution.stdout.slice(-4000),
      stderrPreview: execution.stderr.slice(-4000),
    });
  }

  if (!newFiles.length) {
    throw createWorkerError('no-new-image-detected', 'no new image detected after codex exec completed', {
      stdoutPreview: execution.stdout.slice(-4000),
      stderrPreview: execution.stderr.slice(-4000),
    });
  }

  const latest = newFiles[0];
  const stableSize = await waitForStableSize(latest.path);

  let outputPath = latest.path;
  if (options.outputPath) {
    outputPath = path.resolve(options.outputPath);
    try {
      ensureParentDir(outputPath);
      fs.copyFileSync(latest.path, outputPath);
    } catch (error) {
      throw createWorkerError('artifact-copy-failed', `failed to copy generated image to ${outputPath}`, {
        outputPath,
        sourceImagePath: latest.path,
        cause: error.message || String(error),
      });
    }
  }

  return {
    ok: true,
    prompt,
    images,
    workdir,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    sourceImagePath: latest.path,
    outputPath,
    size: stableSize,
    codexStdoutPreview: execution.stdout.slice(-1000),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const prompt = args._[0];
  if (!prompt) usage();

  const timeoutSec = Number(args['timeout-sec'] || DEFAULT_TIMEOUT_MS / 1000);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) usage();

  const rawImages = args.image;
  const images = rawImages ? (Array.isArray(rawImages) ? rawImages : [rawImages]) : [];

  const result = await generateImage({
    prompt,
    workdir: args.workdir,
    timeoutMs: timeoutSec * 1000,
    outputPath: args.output,
    images,
  });

  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WORKDIR,
  GENERATED_IMAGES_ROOT,
  buildImagegenPrompt,
  createWorkerError,
  generateImage,
};

if (require.main === module) {
  main().catch(error => {
    if (error && error.code) {
      console.error(JSON.stringify({
        ok: false,
        error: {
          code: error.code,
          message: error.message || String(error),
          details: error.details || null,
        },
      }, null, 2));
      process.exit(2);
    }
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
