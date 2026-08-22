# dsh-subscription-auth

`dsh-subscription-auth` 为 dsh 增加订阅会员登录和模型接入。插件不要求用户填写 API key；令牌由 dsh 的凭据服务保管，模型列表在登录后按提供商能力自动发现。

## 原生渠道

插件当前注册且实现的原生渠道只有五个：

| 渠道 | 登录方式 | 原生调用方式 |
| --- | --- | --- |
| ChatGPT | 授权码 + PKCE + localhost 回调 | Codex Responses API |
| Claude | 授权码 + PKCE + localhost 回调 | Anthropic Messages API |
| Grok | RFC 8628 设备授权 | xAI Responses API |
| Kimi | RFC 8628 设备授权 | Kimi Anthropic-compatible Messages API |
| Agy CLI | 检查已认证的 Agy CLI | 无 shell 的 `agy` 子进程 bridge |

Agy 是 Agy 所有的 CLI bridge，不是插件内嵌的模型渠道。插件不包含静态的 Agy 模型目录；没有显式 `models` 时，只使用 `agy models` 动态返回的 ID、名称和上下文信息，并原样保留 Agy 支持的名称（包括可能出现的 Gemini-family ID）。这不代表插件实现了原生 Gemini、Google OAuth 或 Gemini Code Assist。插件不会读取 Gemini credential 文件，也不会调用 Gemini Code Assist。

## 特性

- 统一的登录、注销、状态查询和模型发现路由：
  - `GET /subscription-auth/providers`
  - `POST /subscription-auth/auth/login`，body 为 `{ "provider": "..." }`
  - `POST /subscription-auth/auth/logout`，body 为 `{ "provider": "..." }`
- 只在渠道已登录时注册 provider 和 adapter；注销后从模型选择器撤销。
- ChatGPT 与 Grok 的令牌具备主动续期、单通道并发去重、401 时一次强制续期重试、持久失效（`invalid_grant` 等）自动清理与瞬时失败仅在未过期时回退。Claude、Kimi 的原有续期保持不变。
- Responses 适配器（ChatGPT/Grok）在空闲超时（默认 300s，可注入覆盖）时安全中止流，避免长时间挂起。
- 发现结果可持久化到 settings；手动 `models` 优先于持久化发现结果。
- 发现只有 `id/name` 时会与内置目录合并。Grok `grok-4.6` 的目录 context window 为 `500000`，不会错误回退为渠道默认的 `1000000`。
- Provider 错误统一提取嵌套 `message/code/type/details`，去除 `[object Object]` 并脱敏 Bearer、token、API key 等敏感值。
- Kimi 的上下文超限响应即使是 HTTP 401 也分类为 `CONTEXT_WINDOW_EXCEEDED`，真正的失效令牌才分类为 `AUTH`。
- Agy 使用固定参数、`shell: false`、stdout 上限、结构化输出 envelope 校验以及只杀掉当前请求创建的子进程；abort 会终止该子进程，不会杀进程组。

## 安装和构建

这是一个 dsh 外部插件包，`lib/` 为随仓库提供的生成产物。

```sh
bun install
bun run build
```

把插件目录放到 dsh 的插件目录，并在 dsh bundle patch 中加入：

```yaml
- insert:
    - id: dsh-subscription-auth
      name: dsh-subscription-auth
```

随后重启 dsh。插件需要 dsh 运行时提供 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-credentials` 和 `@deepseek-ai/dsh-settings`；构建只应使用目标 dsh checkout 的依赖，不要把本机安装路径写进仓库。

## 配置

每个渠道使用一个 `subscription-auth-<id>` settings 命名空间。可以复制 [examples/config.example.yaml](examples/config.example.yaml)，再按部署环境修改。示例不包含个人路径、账号、令牌或邮箱。

```yaml
subscription-auth-chatgpt:
  apiBaseURL: https://chatgpt.com/backend-api/codex/responses
  redirectPort: 1455
  maxTokens: 8192

subscription-auth-claude:
  apiBaseURL: https://api.anthropic.com/v1/messages
  redirectPort: 54545
  maxTokens: 64000

subscription-auth-grok:
  apiBaseURL: https://api.x.ai/v1/responses
  maxTokens: 8192

subscription-auth-kimi:
  apiBaseURL: https://api.kimi.com/coding/v1/messages
  maxTokens: 32768

subscription-auth-agy:
  executable: agy
```

`models` 可选。插件按“手动 `models` → 持久化 `discoveredModels` → 本次发现 → 默认目录”选择模型；Agy 的默认目录为空，因此没有显式模型或成功的 `agy models` 发现时不会合成 fallback ID。Agy 的 `executable` 应是受信任的 CLI 路径或 PATH 名称；插件不会通过 shell 展开它。

### OpenCode Go provider-id 冲突

接入 OpenCode Go 或其他宿主时，请保留本插件的稳定 provider ID：`chatgpt`、`claude`、`grok`、`kimi`、`agy`。不要把它们重命名为宿主已经占用的 `openai`、`opencode` 或 `opencode-go`。如果宿主要求二次映射，请在宿主侧使用带命名空间的别名（例如 `dsh-subscription-auth-chatgpt`），并保持模型的实际 provider 字段与注册表一致；否则会出现 provider-id collision，模型可能路由到错误的 adapter。

## 使用

1. 打开 dsh 的“设置 → 订阅服务”。
2. 对 ChatGPT、Claude、Grok 或 Kimi 点击登录并完成浏览器/设备授权；对 Agy 点击登录以执行 `agy models` 检查。
3. 登录成功后，插件发现可用模型并刷新模型选择器。
4. 需要时点击注销。Agy 的注销只清除插件状态，不会删除或修改 Agy 自己的会话。

授权码渠道需要 dsh 进程能够接收 localhost 回调。设备流渠道需要浏览器访问提供商展示的验证地址。网络代理配置和常见失败处理见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## 思考强度

- ChatGPT：`minimal`、`low`、`medium`、`high`，发送为 Responses `reasoning.effort`。
- Claude：`low`、`medium`、`high`，映射为 extended thinking 的预算。
- Grok：`low`、`medium`、`high`，发送为 Responses `reasoning.effort`。
- Kimi：`low`、`medium`、`high`，映射为 `thinking.budget_tokens`。
- Agy：模型 ID 中若有档位，由 Agy 自己解释；插件不额外注入原生 reasoning 参数。

## OpenCode Go 模型目录叠加（muse-spark-1.2-contributor）

`opencode-go/muse-spark-1.2-contributor` 是上游 OpenCode Go 的官方模型目录叠加条目（`@earendil-works/pi-ai` 的 `opencode-go.json`），不是本插件的原生渠道。本插件的原生渠道仅 `agy` / `chatgpt` / `claude` / `grok` / `kimi` 五个；该叠加仅通过脚本注入到隔离的 dsh runtime，不代表插件内嵌或原生实现了 Gemini。

默认使用稳定隔离路径，无需手写绝对路径：

```sh
node scripts/manage-dsh-runtime.mjs install --dsh-version 0.1.0-rc.8
node scripts/manage-dsh-runtime.mjs check --dsh-version 0.1.0-rc.8
```

- 默认 runtime：`~/.local/share/dsh-subscription-auth/dsh-runtime`，稳定入口为 `<runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js`（脚本会打印该 `entry`，供 launchd 使用）。
- 备份位置：`~/.dsh/backups/dsh-model-catalog`（在 node_modules 之外，保存原始 `opencode-go.json` 的精确回读）。
- 升级时使用显式版本重新执行 `install --dsh-version <exact-version>`（仅接受 `x.y.z` 或 `x.y.z-prerelease` 严格格式），再将打印的 `entry` 路径更新到 launchd 配置。
- 不要直接编辑 `_npx` 缓存或 `node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json`，也不要在 `settings.yaml` 中对该 provider 强制单一 `protocol`；OpenCode Go 目录混合多种协议，单协议覆盖会破坏其他模型且重启后被覆盖。

## Codex Responses 本地桥接（muse-spark-1.2-contributor）

本插件在 DSH 进程内提供一条本地 Codex Responses 兼容桥接，用于让官方 Codex（`responses` wire_api）通过 DSH 调用 OpenCode Go 的 `muse-spark-1.2-contributor` 模型。它不是浏览器自动化，也不是独立常驻的外部 daemon：桥接由插件在 DSH 的 `webServer` 进程内注册 HTTP 路由，逐请求通过 DSH 的 credential service 解析 `OPENCODE_GO_API_KEY` 并代理到 `https://opencode.ai/zen/go/v1`，对 Codex 发来的请求做归一化后原样透传 SSE 响应。

- 仅在 `127.0.0.1:3080` 注册，绝不在 `127.0.0.1:13081` 的 Tailscale 侧 DSH 实例注册。启动时若 `webServer.host:port` 不是 `127.0.0.1:3080` 或 credential service 不可用，则不注册任何路由。
- 路由（严格精确匹配）：
  - `GET /_codex/v1/models`
  - `POST /_codex/v1/responses`
  - `POST /_codex/v1/responses/compact`（本地 v1 compaction 合成——上游无原生 `/responses/compact`，见下文限制说明）
- `POST /_codex/v1/responses/compact` 为本地 v1 合成：与 `/responses` 完全一致校验 loopback/method/body cap/model/credential，单次调用上游 `/responses` 且 `stream=false`、禁用 tools、无 `previous_response_id`、追加清晰分隔的摘要指令，从 `output_text` 或 `output` 消息内容提取助手文本，返回 `200` 且 `output` 中包含 `role=user` 的 `input_text` 摘要（尾部保留最近用户文本 ≤4000 字符，摘要 ≤10000 字符，总计 ≤12000 字符的严格输出上界）。不声称支持原生加密 compaction 或 v2 `compaction_trigger`。
- 优先暴露 catalog 别名 `opencode-go-responses/muse-spark-1.2-contributor`（`GET /_codex/v1/models` 首位），同时保留 canonical `muse-spark-1.2-contributor` 以兼容旧配置；两者之外的任何前缀/ID 返回 `400 model_not_supported`。桥接在每次上游 `/responses` 调用前（含 `compact` 合成）将别名或 canonical 精确翻译为 canonical `muse-spark-1.2-contributor` 再透传；缺省 `model` 时默认 canonical。
- `reasoning.effort` 归一化：`none`/`off`/`minimal` → `low`，`xhigh`/`max` → `high`，`low`/`medium`/`high` 保持不变，缺省为 `high`。已修复上游 `reasoning.effort="none"` 在本地被错误透传导致的选择器显示为 `off/minimal` 的问题。
- `tools` 存在时强制 `tool_choice="auto"`（覆盖任何传入的 `tool_choice`）；无 `tools` 时删除 `tool_choice`/`toolChoice`。已修复无工具时仍透传 `tool_choice="required"` 导致的上游报错。
- `prompt_cache_key` 语义：若请求 JSON 已自带 `prompt_cache_key`（即使为 `null` 或空字符串）则精确保留、绝不覆盖；仅当未自带且存在有效会话标识时，才由桥接无状态合成注入。合成仅依赖请求头中的有效 Codex UUID（优先级 `thread-id` > `session-id` > `session_id` > 递归解析 `x-codex-turn-metadata` JSON 且仅识别 `conversationId`/`conversation_id`/`sessionId`/`session_id`/`threadId`/`thread_id`），以固定版本化域 `codex-session-cache:v1` + NUL 分隔的 `modelId` 与 UUID 经 SHA-256 base64url 哈希生成，上游 key 不含原始 UUID、长度 `<64`，暴露的纯函数为 `deriveCodexSessionCacheKey(headers, modelId)`。缺失/畸形/非法头返回 `undefined` 且不注入；无关 UUID（如 `turn_id`/`client` 伴随的 decoy）在 metadata 中被忽略，仅 `thread_id` 等已识别键下的 UUID 才生效。无服务端会话表，不合成 `previous_response_id`，不记录头/UUID/key/body/密钥。`POST /_codex/v1/responses` 与 `POST /_codex/v1/responses/compact` 均一致生效；上游 `usage.input_tokens_details.cached_tokens` 等缓存统计在 SSE 中字节级透传。
- Stateless 会话复用说明：同一 `thread-id`/`session` 的多次请求映射到同一稳定 `prompt_cache_key`，从而在无状态前提下复用上游 prompt cache；不同 thread 或不同 `modelId` 域隔离为不同 key；显式 `prompt_cache_key` 始终优先。
- 密钥解析：每次请求实时调用 `credentialRef("OPENCODE_GO_API_KEY")` 的 `resolve`，未配置返回 `401 missing_api_key`；Codex 配置或仓库中不存放任何上游 key。
- 协作边界（fail-closed）：`input` 中若出现 `type: agent_message`（Codex 内部类型，含 `input_text` envelope + `encrypted_content`）或任何嵌套 `type: encrypted_content`，桥接在 `/responses` 与 `/responses/compact` 均直接返回 `400 { code: collaboration_transport_unsupported }`，不解密、不转发 ChatGPT 凭据、不静默剥离密文、不调用上游；指引调用方使用 Router 生成的 `router_opencode_go_responses_muse_spark_1_2_contributor`（Router 拥有加密中继）。DSH 桥接仅支持主会话/直接 Responses 与缓存。

### Codex 配置（精确）

Codex 通过自定义 provider 指向本地桥接，无需在 Codex 侧配置 `api_key`：

```toml
# ~/.codex/config.toml
[model_providers."dsh-opencode-go"]
name = "DSH OpenCode Go"
base_url = "http://127.0.0.1:3080/_codex/v1"
wire_api = "responses"
# api_key 留空或不填；由 DSH credential service 逐请求提供
```

#### DSH 桥接边界与协作分流（重要）

- DSH 桥接 **仅支持** Codex 主会话/直接 `Responses` 与 `prompt_cache_key` 缓存。**不支持** Codex 原生协作的加密子代理/跟进负载。
- 任何 `/responses` 或 `/responses/compact` 的 `input` 中出现 `type: agent_message`（Codex 内部类型，内含 `input_text` envelope + `encrypted_content`）或任何嵌套内容片段 `type: encrypted_content` 时，桥接将 **fail-closed** 返回 `400 { code: collaboration_transport_unsupported }`，**不解密、不复制 Router 中继代码、不转发 ChatGPT 凭据、不静默剥离密文、不调用上游**。错误消息会指引调用方使用 Router 生成的 agent。
- 原生 Muse 子代理/跟进（subagent/follow-up）**必须**使用 Codex Router 生成的 `router_opencode_go_responses_muse_spark_1_2_contributor`，因为加密协作负载需要 Router 的已认证原生中继；`dsh-opencode-go` 自定义 provider **故意不**持有 ChatGPT 凭据链。不要将 `dsh_muse_coder` 用作原生协作 agent——它仅为历史示例，协作场景下不具备加密中继能力。

DSH 桥接用于单主会话直接调用的示例（顶层字段，非 `[agents.muse_coder]`，仅限非协作主会话）：

```toml
# ~/.codex/agents/dsh-muse-coder.toml  — 仅用于主会话直接调用，不适用于原生协作/子代理
name = "dsh_muse_coder"
description = "Bounded coding agent for DSH workspace tasks (main session only, no encrypted collaboration)"
model_provider = "dsh-opencode-go"
model = "opencode-go-responses/muse-spark-1.2-contributor"
# 上游仍为 muse-spark-1.2-contributor；桥接在 /responses 前精确翻译（仅接受 canonical 与该精确别名）
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
developer_instructions = """
You are a bounded coding agent. Keep changes minimal and within the workspace. Prefer tests and verify before concluding.
"""
```

原生协作请改用 Router agent（由 `codex-router` 生成，拥有加密中继）：

```toml
# 由 Codex Router 生成，无需手写；示例仅示意其归属
# agent: router_opencode_go_responses_muse_spark_1_2_contributor
# model_provider 指向 Router 的已认证中继，而非 dsh-opencode-go
```

> 注意：`~/.codex/config.toml` 中的 `[agents]` 仅为全局 agent 设置，并非命名 agent 定义；自定义 agent 须为 `~/.codex/agents/` 下的独立文件并使用顶层字段。`~/.codex/config.toml` 仅保留 `[model_providers."dsh-opencode-go"]`。

> Codex App 修改 `model_providers` / `agents` / `catalog` 后必须完全重启才能重载配置；仅重载窗口或热重载不会生效。

### 密钥轮换命令 `dsh-opencode-key`

本地安装/链接（在仓库根目录执行一次）：

```sh
bun link
# 将会在本地包管理器 bin 中创建 dsh-opencode-key（指向 scripts/rotate-opencode-go-key.sh）
# 该脚本会通过解析 BASH_SOURCE 的一层或多层 symlink 定位真实脚本目录，因此 bun link / npm link 等 bin 链接可用
```

使用：

```sh
dsh-opencode-key
# 交互式隐藏输入：Enter new OpenCode Go API key: （不回显） + Confirm key: （不回显）
# 校验：非空、无空白、以 sk- 开头且总长度与前缀后长度满足最小阈值
# 仅更新已存在的本地存储：Pi (~/.pi/agent/auth.json 的 opencode-go)、OpenCode (~/.local/share/opencode/auth.json 的 opencode-go)、Codex secret (~/.codex/codex-router/opencode-go-api-key.secret)
# 缺失的存储不创建，直接跳过；已存在的以原子写、0600 权限、fsync + 同目录重命名完成
# 最后通过 DSH 的 credential RPC 调度：先 credentials.describe 校验 writable，再 credentials.set 写入；任一步失败则回滚已写的本地文件
```

安全特性：脚本全程 `set +x` 关闭 xtrace，密钥仅通过 stdin 管道传给 helper（不出现在 argv/env）；helper 在失败时清理临时文件并在写入前拒绝 symlink 链；权限始终 `0600`。

## 隐私和安全

插件只通过 dsh credential service 读取本插件定义的渠道令牌，不记录令牌、账号或本机绝对路径。日志只输出有限的状态信息；provider 错误会先做敏感信息脱敏。Agy 的 stdout 只接受最终 `result.structured_output`，stderr 只排空不回传。

Codex 桥接的额外边界：仅接受 loopback 来源（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`），请求体上限 10 MiB，不记录请求/响应体，不向下游透传 `authorization`/`cookie` 等敏感头，同一用户的本地进程方可通过 loopback 访问。请勿将桥接端口对外绑定或通过代理暴露。

请阅读：

- [docs/SECURITY-PRIVACY.md](docs/SECURITY-PRIVACY.md)
- [SECURITY.md](SECURITY.md)
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## 开发和测试

```sh
bun run build
bun run test:clean
bun run test:privacy
bun run test:source
bun run test:lib
bun run test
bun run test:all  # requires the dsh runtime peer packages
```

`test:clean` 不依赖本机账号、外部模型 CLI、外部网络或某个固定安装目录；它检查发布树、五渠道注册表和 rc.6 helper 的安全边界。完整的贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证和声明

本项目采用 BSD-3-Clause，见 [LICENSE](LICENSE)。上游来源和保留声明见 [NOTICE.md](NOTICE.md)。

### 项目来源与致谢

本仓库是一个独立的 GitHub 仓库，不属于 GitHub 的 fork network。项目最初基于 [Khellendros97/dsh-subscription-auth](https://github.com/Khellendros97/dsh-subscription-auth) 的公开实现和思路继续开发；感谢原作者 Khellendros97 对 dsh 订阅渠道接入的探索和 BSD-3-Clause 开源授权。

当前版本已经对渠道抽象、错误处理、登录门控、Agy CLI bridge、沙箱兼容、测试、文档和隐私边界做了较大扩展，但仍属于衍生作品，而不是 clean-room 完全重写。原项目的版权声明和许可证条件继续保留在 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md) 中。
