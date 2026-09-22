# DSH 多模型决策室

将一份方案交给多个模型的不同角色独立评审，围绕问题持续质询，再生成完整修订稿和独立复核。人负责目标、边界、补充事实与最终取舍。

首版是 **DSH 插件**，面向可信的单用户本地 Profile。开发预览复用同一套 Host 逻辑与页面，不是另一个独立业务系统。

项目地址：<https://github.com/JinhangShi/dsh-decision-room>

## 安装

从 npm 安装到 DSH Web Profile：

```sh
dsh plugin --profile web add dsh-decision-room@0.8.0
```

本地开发包也可以按下文的“打包与 DSH 安装”方式安装。

## 当前功能

- 默认四席为商业与客户价值、产品与交付、财务风险与合规、独立反方与证据审计；提供商业决策、企业尽调、产品方案、技术架构和采购评估模板。
- 高级设置允许 2–6 个席位，自定义名称、职责、评审视角和模型；删除交付、风险或独立反方时显示警告。
- 独立首评使用同一份冻结材料，不读取其他席位意见，全部提交后统一公开。
- 以稳定的问题 ID 轮转分配交叉回应；高风险问题至少由两个不同席位独立覆盖，保留修改理由、证据缺口、阻断票与少数观点。
- 每轮结束后由主持模型解读 Host 的确定性票型，说明关键阻断、变化和下一步；主聊天及右侧栏保留每轮快照，模型不能改写票数或把多数意见当作事实。
- 15 分钟、1 小时、4 小时和“持续评审”（最长 8 小时）四种固定评审模式；界面不暴露轮次、调用、Token、并发和超时参数，达到任一模式边界即停止派发。持续评审适合长时间无人值守运行，预留更多交叉质询、格式重试和复杂材料处理额度；观点提前收敛时会提前完成，不会人为等待满 8 小时。
- Host 按问题覆盖、证据状态、信息增量和连续两轮票型稳定性决定收尾；票数呈现分歧但不能把事实投票为真。时间是上限，不是必须耗满的时长。
- 每次调用前持久化预算预留。最多两个运行中任务、Profile 内最多四个并发请求。
- 暂停、取消、检查点续跑、重启恢复、用户要求提前修订；迟到响应不会改写已暂停或取消的结论。
- 无人值守运行仍需要 DSH 进程、插件宿主和电脑保持运行（建议关闭系统睡眠）；进程或机器停止后任务会暂停，并在恢复后从检查点继续，不承诺离线期间继续调用。
- 完整修订方案、逐项修改映射、独立复核、试点验证计划、Host 自动附加的未解决异议。
- 人工采纳／不采纳／暂缓，绑定确切报告版本；补充反馈后创建新版本，旧记录保持不变。
- Markdown/TXT 方案及补充材料、Markdown/安全 HTML 导出、当前会话历史。
- DSH 主聊天显示角色评审、交叉回应、修订稿与复核；按版本留存，刷新和重启不会重复发布。
- 左侧“决策室”与 MCP 连接器、访前尽调入口使用相同原生按钮样式与导航区域；主输入区不再出现重复的打开按钮。
- 右侧“新的决策”卡片填写议题、材料、角色与预算，实时同步为可编辑的主聊天草稿；用户点击 DSH 发送后，主持 Agent 调用工具启动四席评审。
- 主聊天执行卡片实时显示阶段、各模型调用状态与额度；暂停、继续、补充材料、二次修订和人工取舍都在同一聊天中完成。
- 各角色使用独立的 DSH 原生会话，由 DSH 管理历史、Token 估算及自动压缩；首评完成前互相不可见。
- 左侧入口打开 Better Sidebar 右侧配置卡片；发送后卡片转为只读进度，后续讨论和修订保留在主聊天。

## 已有模型与边界

默认使用现有网关的四个模型 ID：

| 席位                       | 模型 ID               |
| -------------------------- | --------------------- |
| 商业与客户价值、主持与编辑 | `qwen3.8-max`         |
| 产品与交付、独立复核       | `kimi-k2.6`           |
| 财务、风险与合规           | `glm-5.1`             |
| 独立反方                   | `deepseek-v4.1-flash` |

2026-09-18 的短文本调查中，上述四项均成功且返回的 `model` 与请求一致。默认目录只展示这四个已测模型；其他供应商只有在 Host 明确配置并启用后才会出现。配置了协议不代表已有供应商权限。

不默认启用曾发生身份不一致的 MiniMax 别名和 DeepSeek Pro 日期别名。运行中仅接受请求名或明确登记的返回别名；其他模型名仍会停止并保留已报告用量。现有网关的 `deepseek-v4.1-flash` 可返回 `deepseek-v4-1-flash-260910`，该精确对应关系已纳入兼容列表，不泛化接受其他日期、Pro 或旧 Flash 标识。请求仍使用短名称，调用记录和报告保留网关原始返回名。DSH 原生流没有返回上游身份时显示未知。模型名匹配只能核对网关声明，不能独立认证真实供应商。

首版不接外部搜索和 MCP 证据工具，不自动修改业务系统，不执行方案中的脚本。用户提交材料与模型知识都不等同于外部事实核验。事实／缺证问题不会仅因复核模型认为“已处理”就标成事实已证实。

## 本地开发预览

要求 Node.js 22.19+ 或 24、pnpm 10。

```sh
pnpm install --frozen-lockfile
pnpm dev:demo
```

打开 `http://127.0.0.1:4318/decision-room/`。演示模式明确标注“无外部调用”，使用确定性合成结果。

真实模型模式只复用你已有的凭据。创建不提交 Git 的 `.env.local`：

```dotenv
DSH_DECISION_ENV_FILE=/absolute/path/to/existing/.env.dev
```

该文件只导入 `AI_GATEWAY_` 和 `DECISION_PROVIDER_` 前缀环境变量，不加载原仓库其他业务凭据。也可以直接在 Host 环境中设置 `AI_GATEWAY_BASE_URL` 和 `AI_GATEWAY_API_KEY`。调用只允许 HTTPS，不跟随重定向。

```sh
pnpm dev
```

页面代码和任务响应中都不会包含 API 密钥。当前交付的本机 `.env.local` 只引用已存在的环境文件路径，没有复制其中的密钥。

## 安装到现有 DSH

本项目参照现有 `qcc-previsit-dsh` 的 Host/Client、Bundle patch、Session 工作台和 `storageDomain` 方式实现。参考稳定组合为 DSH `0.1.1-rc.2` + Better Sidebar `0.17.1`；候选组合为 DSH `0.1.2-rc.1` + Better Sidebar `0.18.1`。不自动升级现有宿主或其他插件。

先构建并打包：

```sh
pnpm build
pnpm pack --pack-destination dist
```

完整停止你准备安装的 DSH Profile，然后执行：

```sh
dsh plugin --profile web add /Users/qcc/WebstormProjects/dsh-decision-room/dist/dsh-decision-room-0.8.0.tgz
```

启动 DSH 的进程需要同一份 Host 环境配置，插件不会读取浏览器存储中的密钥：

```sh
DSH_DECISION_ENV_FILE=/Users/qcc/WebstormProjects/mcp_web/apps/web/.env.dev dsh web
```

通过 **localhost / 127.0.0.1** 打开 DSH。点击左侧“决策室”进入专属 Session，右侧打开“新的决策”卡片。填写“01 议题与材料”和“02 成员与边界”时，prompt 实时出现在主聊天输入框，不需要额外点击回填。这一步不会创建评审或调用模型；核对后点击 DSH 原生发送才启动。

如已手工修改主聊天草稿，自动同步会暂停并提示，避免覆盖输入。卡片草稿按工作空间／会话缓存在当前浏览器标签页中，刷新或重新打开可恢复。发送后右侧转为只读进度，补充意见和二次修订继续在主聊天完成。

自然语言入口：也可以直接在主聊天提供方案和明确的评审指令。DSH 主持 Agent 使用 `decision_room_start` 启动真实评审；只有暂存请求使用 `decision_room_prepare`。同一用户消息的重复启动会去重。`decision_room_status` 只读查看状态和结果。

在主聊天发送“请根据这些意见再次评审”，Agent 使用 `decision_room_continue` 创建并启动下一版，默认基于上一版修订稿及原预算。只补充或暂存意见时不自动收费续议。`decision_room_control` 控制暂停、继续、取消和收尾；`decision_room_limits` 接受用户明确要求的额度调整；`decision_room_decide` 记录人工取舍。

关闭页面不停止已经授权的评审。需要停止时，在主聊天发送“暂停评审”或“取消评审”；执行卡片也提供回填指令的快捷按钮。**DSH 原生停止按钮只停止当前主持回复；评审任务以执行卡片的状态为准**。

主聊天的主持 Agent 需要使用 DSH 中已配置、支持工具调用的模型。角色调用走决策室现有网关；主持的普通聊天调用由 DSH 自身管理，不计入角色评审的调用次数。

## 供应商与价格配置

复制 `models.example.json` 为 `models.local.json`，修改精确模型 ID、角色可选名称、协议及环境变量引用，然后设置：

```dotenv
DSH_DECISION_MODELS_FILE=/absolute/path/to/models.local.json
```

支持 `chat`（Chat Completions）、`messages`（Anthropic Messages）、`responses`（OpenAI Responses）、`dsh`（宿主 `llm.stream`）。同一供应商的 base URL、模型 ID 和凭据必须成套配置。`dsh` 模型需填写宿主已经配置的 `provider`；此路线使用宿主凭据，不经过插件 HTTP 适配器。

模型价格默认为 `null`。拿到实际 API 计价后，填写人民币／百万 Token 的 `inputCnyPerMillion` 和 `outputCnyPerMillion`，才能启用金额预算。缓存按输入价保守计算；这不是供应商结算账单。

DSH 中按宿主 Token Meter 估算，并在发送请求前按实际原生上下文和输出上限持久化预算预留，收到 usage 后结算。压缩请求单独计入调用次数、Token、金额及时间边界。独立开发预览仍使用 UTF-8 字节数保守估算，不能代表原生压缩能力。

超时、取消、网络中断、缺少 usage 的调用保留预留额度，显示“待对账”。上游推理 Token、计费语义和取消行为不能由插件保证；发现实际报告用量超过总额度会停止后续请求。没有配置价格时，使用 Token、调用次数和时间限制，不把费用显示为零。

每个逻辑步骤最多尝试三次，失败会暂停，用户点击继续才重试。重试消耗独立预算，不覆盖之前失败或中断的调用记录。修改模型配置后应创建新版本，已有任务不会静默使用变更后的模型定义。

## 验证命令

```sh
pnpm test          # 核心状态机、预算、协议、访问边界与存储测试
pnpm build         # Host、DSH Client、工作台资源、声明文件
pnpm test:e2e      # 合成模型浏览器验收；需要本机 Chrome 或 Playwright Chromium
pnpm typecheck    # 交付前最后一步
```

浏览器验收默认复用已安装的 Chromium/Google Chrome。可通过 `DSH_DECISION_CHROME` 指定可执行文件。截图保存在忽略 Git 的 `test-results/`。

`pnpm smoke:live` 是**会产生 API 调用**的显式验收命令：使用不含业务数据的合成方案，最多 16 次调用、1 轮讨论、15 分钟、60 万 Token 预留额度。结果保存在 `.decision-room/live-smoke-result.json`，不会提交到仓库。

## 存储、安全与适用范围

- DSH 中由 `decision_room_v1` Storage Domain 保存任务、预算和问题账本；角色历史和主聊天消息使用 DSH 原生 Session 持久化。开发预览使用 `.decision-room/{demo,live}/runs.json`。
- 升级会把旧任务已公开的评审同步到原会话主聊天，并保留成功检查点；重启不会自行继续付费任务。
- 自动压缩不意味着无限容量。单份输入本身过大、压缩失败或预算不足仍会暂停并保留结果，不会静默截掉硬约束。
- Host 更新串行写入并先持久化再发布；开发文件存储以临时文件原子替换。损坏记录导致启动失败，不清空旧数据，不回退到无持久化模式。
- 重启将运行中任务恢复为暂停，不自动产生新的付费请求。保留成功检查点、问题 ID、版本、事件与用量。
- HTTP 路由同时检查本机 socket、Host、同源 Origin／Fetch Metadata；所有任务 API 还要求随机访问凭证，存放浏览器内存，不放 URL。它是可信本地 Profile 的防跨站边界，**不是多人租户认证**。
- 任务操作、读取和导出都校验 Workspace/Session；版本冲突使用 revision 拒绝。Profile 的其他可信插件／本机进程仍属于同一信任边界。
- 不接收前端提交的网关 URL、密钥或已完成报告；模型仅产出受 schema 和引用检查约束的数据。
- 模型和材料文本以 React 文本节点或 HTML 转义呈现，不执行原始 HTML。未解决问题由 Host 自动附加，编辑模型不能将它们删除。
- 第一版只显示当前会话历史；反馈续议重新进行完整独立评审，以免旧主持摘要影响首轮。自动识别影响范围后只复审局部问题、跨会话全局历史、只读外部补证和多用户权限是后续扩展点。

开发方案见 [docs/DEVELOPMENT-PLAN.md](docs/DEVELOPMENT-PLAN.md)，架构与状态机见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，验收证据见 [docs/VALIDATION.md](docs/VALIDATION.md)。
