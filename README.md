# mindcode-claw-image2

[中文版](./README.zh-CN.md) | English

A publishable draft of a **thin skill + local service** package that lets your agent, whether OpenClaw, 爱马仕, or another claw-style agent, use your existing GPT subscription entitlement and quota to generate images through Image 2.

## Purpose

The point of this project is simple:

- let your agent use **your own GPT subscription entitlement and quota**
- route image generation through **Image 2**
- make that capability directly callable from claw-style agents such as **OpenClaw**, **爱马仕**, and similar agent setups

This package does not create a new image model account. It exposes a stable local path so your agent can use the image-generation capability you already have.

## What this package is

This repo combines two layers:

1. **A thin skill** (`SKILL.md`)
   - routes requests to the Codex imagegen path when the user explicitly asks for it
   - defaults to raw prompt pass-through
   - prevents silent fallback to HTML layout, manual infographic workflows, or unrelated image tools

2. **A local service** (`scripts/`)
   - wraps `codex exec` image generation behind a small HTTP API
   - provides health checks, async jobs, artifact persistence, install flow, and smoke testing

The service is the execution layer.
The skill is the boundary layer.

## Repo layout

```text
mindcode-claw-image2/
├── SKILL.md
├── README.md
├── PUBLISHING.md
├── LICENSE
├── launchd/
│   └── com.openclaw.codex-imagegen-service.plist
└── scripts/
    ├── codex-imagegen-service.js
    ├── codex-imagegen-worker.js
    ├── codex-imagegen-smoke-test.js
    ├── codex-imagegenctl.js
    └── install-macos-launchd.sh
```

## Prerequisites

- `codex` CLI installed locally on the user's machine
- a valid Codex or GPT subscription/path that actually permits image generation
- enough upstream quota, credits, or allowance for image generation jobs
- Node.js 18+
- macOS if you want to use the included `launchd` install path
- a machine where generated Codex images land under `~/.codex/generated_images`

Important: this package does **not** provide image-generation entitlement by itself. It only wraps an already-working local Codex imagegen capability.

## Install on macOS with launchd

```bash
bash scripts/install-macos-launchd.sh
```

What this does:
- resolves the repo root
- fills the `launchd` plist template
- installs it to `~/Library/LaunchAgents/`
- bootstraps and kickstarts the service
- runs a basic `/health` check

What this does **not** prove:
- that the local `codex` account has imagegen permission
- that the upstream subscription is active
- that the account still has remaining quota or credits

## Control commands

```bash
node scripts/codex-imagegenctl.js install
node scripts/codex-imagegenctl.js start
node scripts/codex-imagegenctl.js stop
node scripts/codex-imagegenctl.js restart
node scripts/codex-imagegenctl.js status
node scripts/codex-imagegenctl.js health
node scripts/codex-imagegenctl.js smoke
node scripts/codex-imagegenctl.js submit --prompt "a red cube on white background"
node scripts/codex-imagegenctl.js job <job-id>
node scripts/codex-imagegenctl.js logs --follow
```

## Service contract

### Endpoints

- `GET /health`
- `POST /v1/images/generations`
- `GET /v1/jobs/:id`

### Behavior

- the service runs one queued job at a time
- artifacts are written to `<CODEX_IMAGEGEN_ARTIFACT_ROOT>/<job-id>.png`
- completed and failed jobs expire from in-memory state after `CODEX_IMAGEGEN_JOB_TTL_MS`
- persisted state is stored in `CODEX_IMAGEGEN_JOB_STATE_FILE`
- if the service restarts while a job is queued or running, that job is recovered as failed with `service-restarted`

## Run locally without launchd

```bash
node scripts/codex-imagegen-service.js
```

Health check:

```bash
curl -sS http://127.0.0.1:4312/health
```

Submit a job:

```bash
curl -sS -X POST http://127.0.0.1:4312/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"prompt":"a minimal white image with a tiny black dot centered","timeout_sec":180}'
```

Smoke test:

```bash
node scripts/codex-imagegen-smoke-test.js
```

## Configuration

Supported environment variables:

- `CODEX_IMAGEGEN_PORT`
- `CODEX_IMAGEGEN_ARTIFACT_ROOT`
- `CODEX_IMAGEGEN_JOB_TTL_MS`
- `CODEX_IMAGEGEN_JOB_STATE_FILE`
- `CODEX_IMAGEGEN_WORKDIR`
- `CODEX_IMAGEGEN_BASE_URL`
- `CODEX_IMAGEGEN_SMOKE_PROMPT`
- `CODEX_IMAGEGEN_SMOKE_TIMEOUT_SEC`
- `CODEX_IMAGEGEN_SMOKE_MAX_WAIT_MS`
- `CODEX_IMAGEGEN_SMOKE_POLL_INTERVAL_MS`

## Notes on text-heavy images

The service can submit any prompt, including infographic, timeline, poster, and text-art prompts.

For Image 2, the default behavior should be:
- trust the requested Image 2 route
- generate directly
- do not add a conservative warning just because the request contains a lot of text

It should **not** silently replace the request with an HTML or manual design workflow.

## Publishing

See `PUBLISHING.md` for the release checklist and sanitization pass.

## Naming note

Public project name:
- `mindcode-claw-image2`

Internal technical identifiers intentionally remain:
- `codex-imagegen-service`
- `codex-imagegen-worker`
- `codex-imagegenctl`
- `CODEX_IMAGEGEN_*`

## ⭐ Like it? Star it!

If you find this project interesting, give it a star, it helps others discover it too.

## Follow Me

I write about AI, startups, and psychology.

- WeChat public account: MindCode
- X: [@moneygalaxy](https://x.com/moneygalaxy)
- Substack: [mindcodeplus](https://mindcodeplus.substack.com)
