# import_chat 指南 —— 来源格式表、参数语义与重导规则

`import_chat` 工具的长文说明。工具 schema 刻意保持很小：只带 format 枚举、必填的 `path`
和每个参数一行说明 —— 够发起调用即可。其余内容（每个来源的数据放在哪、每个参数实际改变
什么、重导会怎样）都在这里，只在真的要导入时才加载。

已注册为宿主运行时 skill **`dsh-chat-import-usage`**：`import_chat` 的 schema 里点名它；
同一份内容也是包内的本文件（`docs/`），所以没有 skills 服务的 agent 仍能读到。

## 用哪个 format，数据在哪

`path` 接受转录文件、会话目录或整个数据根：单个文件 / 库 → 一个会话，目录 → 批量。
各来源的根形状如下（第二列与代码里的来源表逐字一致，由门禁对账）：

| format | path 形状 |
| --- | --- |
| `claude` | Claude Code JSONL (~/.claude/projects) |
| `codex` | Codex / ChatGPT CLI rollout JSONL (~/.codex) |
| `chatgpt` | ChatGPT web export conversations.json (one file, all sessions) |
| `cursor` | Cursor agent transcript JSONL (~/.cursor/projects) |
| `gemini` | Gemini CLI session JSON (~/.gemini/history) |
| `antigravity` | Antigravity session transcript (~/.gemini/antigravity / antigravity-cli) |
| `reasonix` | Reasonix session JSONL (~/.reasonix/sessions) |
| `opencode` | opencode db opencode.db — V1 or V2 schema (~/.local/share/opencode) |
| `mimocode` | mimocode db mimocode.db (~/.local/share/mimocode) |
| `kilocode` | Kilo Code db kilo.db (~/.local/share/kilo) |
| `teleagent` | TeleAgent db teleagent.db (TeleAgent/users/<account>) |
| `zcode` | z.ai zcode db.sqlite (~/.zcode/cli/db) or zcode://<sessionId> |
| `grokbuild` | Grok Build session directory (summary.json + chat_history.jsonl) |
| `openclaw` | OpenClaw session JSONL (~/.openclaw/agents) |
| `hermes` | Hermes db state.db (~/.hermes) |
| `pi` | Pi session JSONL (~/.pi/agent/sessions) |
| `omp` | oh-my-pi session JSONL (~/.omp/agent/sessions) |
| `kimi` | Kimi CLI / Kimi Code session directory (wire.jsonl + state.json) |
| `qoder` | Qoder CLI session JSONL (~/.qoder/projects) |
| `workbuddy` | WorkBuddy session JSONL (~/.workbuddy/projects) |
| `qwen` | Qwen Work CN (千问办公) session JSONL (~/.qwenworkcn/projects) |
| `trae` | Trae Work state.vscdb (Trae/User/workspaceStorage or globalStorage) |
| `vibe` | Mistral Vibe CLI session directory (~/.vibe/logs/session) |
| `continue` | Continue session JSON (~/.continue/sessions) |
| `cline` | Cline session messages.json (~/.cline/data/sessions) |
| `goose` | Goose session db sessions.db (~/.local/share/goose/sessions) |
| `zed` | Zed agent thread db threads.db (<data_dir>/threads) |
| `crush` | Crush session db crush.db (<project>/.crush) |
| `dsh` | DSH V0-V3 session logs session[.vN].jsonl[.zstd] ($DSH_HOME/sessions) |
| `dsh4` | DSH V4+ session logs session.v4.jsonl[.zstd] ($DSH_HOME/sessions) |
| `synapse-studio-v2` | Synapse Studio v2 session db agents.db (<userData>/data/agents.db; pre-DSH SQLite era) |
| `local-jsonl` | Any local session file/dir — .jsonl/.jsonl.zstd/.json/.dshbundle.json; three-level auto-detect, parseFormat forces a parser |

`local-jsonl` 本身不是来源，而是「没有来源认领这个文件」时的兜底入口：它自动识别 `dsh` /
`claude` / `codex` / `cursor` / `reasonix` / `pi` / `openclaw` / `hermes` / `qoder` / `vibe` /
`generic`（内容标记 > 路径提示 > 解析器试跑），识别错时用 `parseFormat` 强制指定。

找路径优先用发现而不是猜：`scan_discover` 工具会列出各来源默认根下可导入的会话（可用
`path` / `format` / `query` 过滤），面板「导入会话」是同一份列表。根给错了会直接报错并
点名期望的根，不会写出半成品。

## 参数

每个参数都在工具 schema 里声明；这里说明它实际改变什么。

### 公共

- `path`（必填）—— 来源转录 / 数据库 / 会话目录 / 数据根，形状按 format 查上表。
- `force` —— 即使已导入过也另存一份完整副本（`import-<src>-<n>`）。
- `budget` —— 三层裁剪的上下文预算（tokens）。默认 550k；解析顺序为 参数 > 环境变量 `DSH_IMPORT_CONTEXT_BUDGET` > 模型窗口。
- `storeImages` —— 默认 `true`：来源里的图片落成宿主附件（`ctx.attachments`），在 DSH 里长期可用。`false` 只保留 `[image]` 文本占位；环境变量 `DSH_IMPORT_STORE_IMAGES=0` 同效。
- `preview` —— `true` 零副作用预演：不写任何东西，只返回将要导入的清单。
- `dryRun` —— `preview` 的别名。
- `sessionId` —— 单文件导入的目标 DSH 会话 id；默认 `import-<来源 id>`。
- `recursive` —— 目录模式是否递归子目录（默认 `true`）。
- `expectedHash` —— 期望的源 SHA-256（小写 hex）；不匹配时大声失败，什么都不写。
- `restamp` —— `true` 把导入的时间戳平移到当下（保留相对间隔）；默认保留源时间。
- `workspaceMode` —— 工作区分组：`auto` | `per-project` | `dedicated`（全部导入到一个工作区）。
- `workspaceDir` —— `workspaceMode=dedicated` 时的工作区目录。
- `cwdRemap` —— 跨机器迁移时重写源 cwd 前缀，例如 `[{from:"D:/work",to:"/home/me/work"}]`。最长前缀优先；只作用于新导入（已导入的来源会被跳过——要重来请用 `force`）。

### 来源专属

- `compacted`（claude，历史别名）—— 现在导入压缩摘要本就是默认行为（原生 compaction 检查点），该别名只为旧调用方保留。
- `branch`（chatgpt）—— `main`（默认）只导入主线程；`all` 按分支路径各写一个会话。
- `sessionIds`（一库多会话来源：chatgpt / opencode / mimocode / kilocode / teleagent / zcode / trae / goose / zed / crush）—— 只导入这些源会话 id。
- `fullHistory`（支持压缩的来源）—— `true` 导入全量历史、不写原生 compaction 检查点；默认 `false` 尊重压缩，模型看到的是「摘要检查点 + 其后的内容」。
- `includeToolUseResult`（claude）—— 同时把结构化的 `toolUseResult` 附属件（经 `structuredPatch` / `bashEditDiff` 的编辑 diff、问答、退出码等标量元数据）作为文本附到每条工具结果后。默认 `false`；它会明显撑大转录，且该参数属于参数指纹的一部分（改它需要 `force`）。
- `lineage`（hermes）—— `tail` 只导入 lineage 叶子会话。
- `lineageMode`（reasonix）—— `canonical`（默认）折叠已证实的恢复祖先；`physical` 每个 JSONL 一个会话。
- `parseFormat`（local-jsonl）—— 强制指定解析器而不用自动识别；`generic` 读 interchange v1 文档。

## 重导规则

同一来源导入两次是幂等的：

- **源未变** —— 直接跳过，连读都不读（registry 保存内容指纹）。
- **源增长、DSH 侧会话未被续聊** —— 新轮次增量续写到已有会话。
- **源增长、DSH 侧会话已被续聊** —— 另铸一份副本；旧会话收进 `record.copies`，绝不追加进你的对话。
- **`force: true`** —— 恒另建副本。

会话日志 append-only：导入只做 `create` + `append`，不改写历史。

## 相关

- [USAGE.zh-CN.md](USAGE.zh-CN.md) —— 整个插件的用户文档（工具、面板、命令、设置）。
- [INTERCHANGE.md](INTERCHANGE.md) —— interchange v1 文档格式。
- [architecture.md](architecture.md) —— 导入流水线背后的设计决策。
