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
- ChatGPT、Claude、Grok、Kimi 的令牌在请求前按过期时间静默续期。
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

## 隐私和安全

插件只通过 dsh credential service 读取本插件定义的渠道令牌，不记录令牌、账号或本机绝对路径。日志只输出有限的状态信息；provider 错误会先做敏感信息脱敏。Agy 的 stdout 只接受最终 `result.structured_output`，stderr 只排空不回传。

请阅读：

- [docs/SECURITY-PRIVACY.md](docs/SECURITY-PRIVACY.md)
- [SECURITY.md](SECURITY.md)
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

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
