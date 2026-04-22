# Publishing Notes

This repository is the public draft for **mindcode-claw-image2**, a thin skill + local service package.

## What to check before publishing

### 1. Sanitization

Run a quick scan for private paths, local-only assumptions, or obvious personal markers:

```bash
grep -RniE '/Users/|/home/|127\.0\.0\.1:18800|openclaw/workspace|PRIVATE_NAME|PRIVATE_ID' . --exclude-dir=.git
```

Expected result: no matches that reveal private local context.

### 2. Generalization

Confirm that:
- repo paths are relative or template-based
- launchd template uses `__REPO_ROOT__`
- worker default workdir is repo-root-based or env-configurable
- no installation step depends on one specific machine layout

### 3. Manual verification

Recommended release check:

```bash
node scripts/codex-imagegenctl.js install
node scripts/codex-imagegenctl.js health
node scripts/codex-imagegenctl.js smoke
```

Before asking an agent to install or use this package, make sure the public docs explicitly tell users to verify:
- local `codex` CLI is installed
- upstream Codex or GPT subscription/path allows image generation
- remaining quota or credits are available

The install flow can verify local service wiring. It cannot fully verify billing entitlement or account allowance.

## Release framing

Describe this package as:
- **mindcode-claw-image2**
- a **thin boundary skill** for explicit route fidelity
- plus a **local Codex imagegen service** for execution

Do not describe it as:
- a direct OpenAI image API wrapper
- a generic infographic renderer
- a replacement for all image tools

## Internal naming policy

Public name:
- `mindcode-claw-image2`

Internal identifiers remain unchanged on purpose:
- script names under `codex-imagegen-*`
- launchd label and plist naming
- `CODEX_IMAGEGEN_*` environment variables

## Known limitations

- depends on a working local `codex` CLI setup
- assumes generated images appear under `~/.codex/generated_images`
- text-heavy prompts may still render poorly because that is a model limitation, not a routing limitation
