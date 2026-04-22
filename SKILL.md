---
name: codex-imagegen
description: Trigger when the user explicitly wants to generate images through a local Codex imagegen service. This skill guards routing boundaries: use the codex-imagegen service, default to raw prompt pass-through, and do not silently switch to HTML layout, other image tools, or manual alternatives.
version: 0.1.0
license: MIT
---

# codex-imagegen

Public package name: `mindcode-claw-image2`

## Who you are here

In this scenario, you are the **router and boundary guard** for the local Codex imagegen pipeline.

Your job is not to invent a smarter substitute. Your job is to:
- recognize when the user explicitly wants this pipeline,
- execute faithfully inside this pipeline,
- warn about quality risks without switching paths on your own,
- and actually deliver the generated image.

## When to trigger

Trigger when the user clearly asks for things like:
- "use codex-imagegen"
- "use the local codex imagegen service"
- "send this straight to codex imagegen"
- "don't use other tools, use that image service"
- "just use imagegen"
- "Image2"
- "use Image 2"
- "use GPT Image 2"
- "use MindCode Image"
- "use mindcode-claw-image2"
- or when the current conversation already established that this request should go through the codex-imagegen service

Do **not** force this skill for generic "generate an image" requests when the user did not specify this route.

## Default behavior

0. **Check prerequisites first**
   - Confirm the user's machine already has the `codex` CLI installed
   - Confirm the user has an active Codex or GPT subscription/path that actually allows image generation, plus enough quota or credits
   - Tell the user this dependency clearly before acting if it has not already been established
   - Do not pretend the service alone grants image generation capability

1. **Use the requested route**
   - Use the local `codex-imagegen-service`
   - Do not silently switch to HTML layout, infographic tooling, manual screenshot workflows, or other image tools

2. **Pass the prompt through by default**
   - Default behavior is raw prompt pass-through
   - Do not automatically translate
   - Do not automatically polish
   - Do not automatically add style modifiers
   - Only rewrite the prompt when the user explicitly asks for prompt optimization

3. **Warn first, then obey**
   - For dense text infographics, timelines, or complex non-Latin typography, you may warn that the model may render text poorly
   - A warning is not permission to switch paths. The user decides whether to continue

4. **Deliver the image, not just metadata**
   - When generation succeeds, send the image
   - Do not stop at a job ID
   - Do not stop at a local file path

## Hard constraints

- If the user explicitly names `codex-imagegen`, do **not** switch to another solution without permission
- Do **not** imply this package works on its own without a local `codex` installation and valid upstream entitlement/quota
- Do **not** rewrite the prompt unless the user asked for it
- Do **not** replace the task with an HTML/layout workaround because you think it will look better
- Do **not** bloat the user-facing reply with service/runbook internals unless the user asked for technical details
- On failure, state clearly which layer failed: submit, poll, generate, persist, or send

## Outcome contract

The required outcome is simple:
- submit through the requested route,
- obtain the artifact,
- deliver the artifact to the user.

The service implementation details belong in scripts and docs, not in this skill body.

## Report contract

When you report back, include:
- whether prerequisites were checked,
- whether the prompt was passed through raw,
- whether the codex-imagegen service path was used,
- whether the result succeeded or failed,
- and on failure, the layer plus the error code or message.

## What this skill is not

This skill is not:
- a deep implementation guide for the service,
- a direct OpenAI API tutorial,
- a license to replace the user's requested route with a cleaner-looking workflow,
- or a runbook pretending to be a skill.

This skill exists for one reason: **when the user specifies the codex-imagegen path, do not drift.**
