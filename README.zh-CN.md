# mindcode-claw-image2

中文版 | [English](./README.md)

这是一个可发布的 **薄 skill + 本地 service** 组合包草案，它的目的，是让你的 agent，不管是 OpenClaw、爱马仕，还是别的 claw 风格 agent，都可以直接使用你现有的 GPT 订阅权限和额度，走 Image 2 生成图片。

## 这个项目的目的

这个项目想解决的事很直接：

- 让你的 agent 直接使用**你自己的 GPT 订阅权限和额度**
- 把图片生成路由到 **Image 2**
- 让 OpenClaw、爱马仕以及其他 claw 风格 agent 可以直接调用这条能力链

它不是给你新开一个图片账号，也不是凭空提供新额度。它做的，是把你已经拥有的图片生成能力，包装成一条 agent 可直接调用的本地路径。

## 这是什么

这个仓库由两层组成：

1. **一个薄 skill**（`SKILL.md`）
   - 当用户明确要求走 Codex imagegen 这条链时，负责把请求路由到这条路径
   - 默认原样透传 prompt
   - 防止 agent 悄悄切到 HTML 排版、手工信息图流程，或其他无关的图片工具

2. **一个本地 service**（`scripts/`）
   - 把 `codex exec` 的生图能力包装成一个小型 HTTP API
   - 提供 health check、异步 job、产物落盘、安装流程和 smoke test

service 是执行层。  
skill 是边界层。

## 仓库结构

```text
mindcode-claw-image2/
├── SKILL.md
├── README.md
├── README.zh-CN.md
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

## 前置条件

- 用户本机已经安装 `codex` CLI
- 用户拥有有效的 Codex / GPT 图片生成权限路径
- 用户账户里还有可用 quota、credits 或其他额度
- Node.js 18+
- 如果要走仓库里自带的 `launchd` 安装路径，需要 macOS
- 机器上生成后的图片会落到 `~/.codex/generated_images`

重要说明：这个包**不会**凭空提供图片生成资格。它只是把一条已经可用的本地 Codex imagegen 能力包成 service。

## 在 macOS 上通过 launchd 安装

```bash
bash scripts/install-macos-launchd.sh
```

这个脚本会做这些事：
- 自动解析 repo root
- 填充 `launchd` plist 模板
- 安装到 `~/Library/LaunchAgents/`
- bootstrap 并 kickstart service
- 最后做一次基础 `/health` 检查

但它**不能证明**这些事：
- 当前 `codex` 账户一定拥有 imagegen 权限
- 上游订阅一定有效
- 账户额度一定还够用

## 控制命令

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

## Service 契约

### 接口

- `GET /health`
- `POST /v1/images/generations`
- `GET /v1/jobs/:id`

### 行为

- service 一次只串行执行一个排队 job
- 产物会写到 `<CODEX_IMAGEGEN_ARTIFACT_ROOT>/<job-id>.png`
- 已完成和失败的 job 会在 `CODEX_IMAGEGEN_JOB_TTL_MS` 之后从内存状态中过期
- 持久化状态写到 `CODEX_IMAGEGEN_JOB_STATE_FILE`
- 如果 service 在 job 排队或运行过程中重启，这个 job 会被恢复成失败状态，错误码是 `service-restarted`

## 不通过 launchd 直接本地运行

```bash
node scripts/codex-imagegen-service.js
```

Health check：

```bash
curl -sS http://127.0.0.1:4312/health
```

提交 job：

```bash
curl -sS -X POST http://127.0.0.1:4312/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"prompt":"a minimal white image with a tiny black dot centered","timeout_sec":180}'
```

Smoke test：

```bash
node scripts/codex-imagegen-smoke-test.js
```

## 配置项

支持的环境变量：

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

## 关于重文字图片的说明

service 可以提交任何 prompt，包括信息图、时间线等。但如果模型本身对高文字密度内容渲染不好，skill 正确的行为应该是：
- 先提醒用户
- 继续保持用户指定的路线
- 由用户决定是否继续

它**不应该**擅自把请求替换成 HTML 或手工设计流程。

## 发布

发布前检查与脱敏说明见 `PUBLISHING.md`。

## 命名说明

对外项目名：
- `mindcode-claw-image2`

内部技术标识保留为：
- `codex-imagegen-service`
- `codex-imagegen-worker`
- `codex-imagegenctl`
- `CODEX_IMAGEGEN_*`

## ⭐ 喜欢的话，点个 Star 吧！

如果你觉得这个项目有意思，欢迎点一个 Star，也能帮助更多人发现它。

## 关注我

我主要写 AI、创业和心理学。

- 微信公众号：MindCode
- X：[@moneygalaxy](https://x.com/moneygalaxy)
- Substack：[mindcodeplus](https://mindcodeplus.substack.com)
