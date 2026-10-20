// lib/convert/synapse-studio-v2.mjs — Synapse Studio v2（agents.db）纯规则层
//
// v2 是 DSH 之前的 SQLite 时代：会话存在 `sub_chats.messages` —— **单个 TEXT 列存整段
// 消息数组的 JSON**（不是一行一条消息）。所以「取某会话的消息」必须整列读该行，无法
// 按消息下标查询；反过来，**摘要层则必须完全不碰这一列**：任何派生表达式
// （length() / json_extract()）都会把整列载入并解析，实测在 84 MB 库上把摘要查询从
// 19 ms 抬到 128 ms（≈整列读）。
//
// 三张表（列取自本机实测库）：
//   chats      id, name, project_id, worktree_path, branch, base_branch, created_at,
//              updated_at, archived_at, …
//   sub_chats  id, name, chat_id, session_id, mode, messages(TEXT), created_at,
//              updated_at, stream_id, initial_generation_status, kind, visibility
//   projects   id, name, path, git_remote_url, …
//
// 消息形状：`{ id, role: 'user'|'assistant', metadata: {...}, parts: [...] }`。实测
// 791 条消息只有这两种 role。metadata 有多种形态（29 键的用量块、4 键的模型块），
// 一律不迁移。
//
// **时间戳是 Unix 秒**（实测 1788432564 → 2026-09-03），不是毫秒——按毫秒解会全部落到
// 1970 年。转换时走 convert/core.mjs 的 parseTimeMs(v, { truncSeconds: true })。
//
// part 形状与映射：
//   text          { type, text }                                  → text
//   tool-Thinking { type, toolCallId, state, input:{text}, … }    → reasoning
//                 （思考文本在 **input.text**，不在 output；实测 2412 个里 941 个
//                   input.text 为空且 output 统一是 {completed}，这类整个跳过）
//   data-image    { type, data:{ base64Data, mediaType, filename } } → image
//   tool-<任意>   { type, toolCallId, state, input, inputText, output, result, errorText? }
//                 → tool-call + tool-result（result 与 output 冗余，取 output）
//   tool-Compact  { type, toolCallId, state, input:{status}, output:{status} }
//                 → 跳过（只有 status，没有摘要/边界，无法表达为 IR）
//
// 幂等键：dci 的 registry 以**源文件绝对路径**为键，本库就是 agents.db 路径，逐会话
// 记录在 subTable 下（sub_chat.id 为键）。注意同机存在 data-backup-<版本>-<时间戳>/
// agents.db 快照，每个快照的 sub_chat id 集合都是主库的真子集——手动选快照会导入重复
// 会话且不被判重，由读取层给 warning。

import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, finishSession, mintSessionId, parseTimeMs } from './core.mjs'
import { normalizeTitle, skipResult } from './util.mjs'
import { imageBlockFromBase64, IMAGE_PLACEHOLDER } from './image.mjs'
import { alignStepResults, createTurns, dropDuplicateCalls } from './ir.mjs'

/** 产品名变体（Electron productName）：正式版 / Dev。 */
const PRODUCT_NAMES = ['Synapse Studio', 'Synapse Studio Dev']

/** 库相对 userData 的位置。 */
const DB_RELATIVE = ['data', 'agents.db']

/**
 * Synapse Studio v2 的库路径候选（三平台分叉，与 traeUserDataDirs 同款写法）。
 * 产品名有多个变体 → 返回数组；win32 缺 APPDATA 时返回空数组（无默认根）。
 */
export function synapseUserDataDirs(home, env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    if (!env.APPDATA) return []
    return PRODUCT_NAMES.map((name) => join(env.APPDATA, name, ...DB_RELATIVE))
  }
  if (platform === 'darwin') {
    return PRODUCT_NAMES.map((name) => join(home, 'Library', 'Application Support', name, ...DB_RELATIVE))
  }
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config')
  return PRODUCT_NAMES.map((name) => join(configHome, name, ...DB_RELATIVE))
}

/** 库路径是否落在 data-backup-* 快照目录里（快照与主库会话重叠，导入会产生重复）。 */
export function isSynapseBackupPath(dbPath) {
  return /[\\/]data-backup-[^\\/]+[\\/]/.test(String(dbPath || ''))
}

// ── part → 内容块 ────────────────────────────────────────────────────────────────

// 工具结果取文本：output 优先（Bash 形态是 { stdout, stderr, interrupted, isImage,
// noOutputExpected }，取 stdout、stderr 非空时追加）；result 与 output 冗余，一律不用。
// output 缺失 → null（调用方补空结果，不丢调用）。
function toolResultText(output) {
  if (output === null || output === undefined) return null
  if (typeof output === 'string') return output || null
  if (typeof output !== 'object') return String(output)
  if (typeof output.stdout === 'string') {
    const err = typeof output.stderr === 'string' ? output.stderr : ''
    return (output.stdout + (err ? (output.stdout.endsWith('\n') ? '' : '\n') + err : '')).trim() || null
  }
  const text = JSON.stringify(output)
  return text && text !== '{}' ? text : null
}

// 工具名必须满足模型 API 的 `^[a-zA-Z0-9_-]+$`。v2 里存在 MCP 形态的工具名带空格与斜杠
// （实测 2 个：`talkdesk-developer / talkdesk_resource_get` 等，共 12 次调用），原样发出会
// 被 github-copilot 以 400 invalid_request_body 拒绝——**整轮对话都发不出去**，不只是这个
// 工具调用。非法字符折叠成单个下划线，保持可读（`a / b` → `a_b` 而不是 `a___b`）。
function toolNameOf(type) {
  const raw = type.slice('tool-'.length)
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'tool'
}

// 单个 part → 内容块数组（0..2 个：工具 part 同时给 call 与 result）。
// 返回 null 表示「该 part 不产出任何块」，调用方据part 类型决定是否计数。
function partsOf(part) {
  if (!part || typeof part !== 'object') return { blocks: [] }
  const type = part.type

  if (type === 'text') {
    return typeof part.text === 'string' && part.text
      ? { blocks: [{ type: 'text', text: part.text }] }
      : { blocks: [] }
  }

  // 思考文本在 input.text（不是 output）；实测 2412 个里 941 个为空、output 统一是
  // { completed } —— 这类不产出空 reasoning 块，调用方计入 emptyThinking。
  if (type === 'tool-Thinking') {
    const input = part.input && typeof part.input === 'object' ? part.input : {}
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    return text ? { blocks: [{ type: 'reasoning', text }], thinking: true } : { blocks: [], thinking: true }
  }

  // 图片：字节在 part.data 里（外层 part 只有 { type, data } 两个键）
  if (type === 'data-image') {
    const data = part.data && typeof part.data === 'object' ? part.data : {}
    const block = imageBlockFromBase64(data.base64Data, data.mediaType, data.filename)
    return block
      ? { blocks: [block] }
      // 拿不到合法字节（超限 / 类型不收 / 字段缺失）→ 宿主层按占位导入并计入 degraded
      : { blocks: [], degradedImage: true }
  }

  // tool-Compact 只有 { status }，没有摘要/边界 → 无法表达为 IR，跳过（不计入降级：
  // 它是结构性标记不是内容损失）。
  if (type === 'tool-Compact') return { blocks: [], structural: true }

  // 其余 tool-<任意>：开放命名空间，按通用 tool-call 处理（未知工具名原样保留）
  if (typeof type === 'string' && type.startsWith('tool-')) {
    const name = toolNameOf(type)
    const id = typeof part.toolCallId === 'string' && part.toolCallId ? part.toolCallId : null
    const input = part.input && typeof part.input === 'object' ? part.input : {}
    const isError = typeof part.errorText === 'string' && part.errorText
      ? true
      : (part.state === 'error' || part.state === 'error-available')
    let result = toolResultText(part.output)
    if (isError && typeof part.errorText === 'string' && part.errorText) result = part.errorText
    return { blocks: [], tool: { id, name, input, result, isError } }
  }

  // 未识别 part：保留不了就计数（失败要大声），但不丢整条消息
  return { blocks: [], unknown: true }
}

// user 消息的 prompt：text 块拼接（图片不并进 prompt 文本，独立成块）
function userPrompt(message) {
  const out = []
  for (const part of Array.isArray(message.parts) ? message.parts : []) {
    const { blocks } = partsOf(part)
    for (const b of blocks) if (b.type === 'text' && b.text !== IMAGE_PLACEHOLDER) out.push(b.text)
  }
  return out.join('\n')
}

// user 消息里的图片块（用于 promptBlocks）。拿不到合法字节的载荷不产生块 —— 降级计数
// 在主循环里另算，避免同一张图被数两次。
function imageBlocksOf(message) {
  const out = []
  for (const part of Array.isArray(message.parts) ? message.parts : []) {
    if (part && part.type === 'data-image') {
      for (const b of partsOf(part).blocks) if (b.type === 'image') out.push(b)
    }
  }
  return out
}

/**
 * Synapse Studio v2 会话（lib/sources/synapse-studio-v2.mjs 从 agents.db 抽出的中间
 * JSON）→ DSH 会话。纯函数，不读磁盘。
 *
 * 入参：`raw` 是**消息数组本身**（即 sub_chats.messages 那一列的解析结果），会话级元信息
 * 经 args 带入：{ id?, name?, cwd?, createdAt?, updatedAt?, chatName? }。
 *
 * metadata 一律不迁移（实测 6 个 model 值里 5 个是 v2 别名：sonnet / haiku / default /
 * opus[1m] / gpt-5.6-luna；provider 只有 claude-code 与 github-copilot），故本函数不写
 * model 字段——落盘时由宿主绑当前默认模型。
 */
export function convertSynapseStudioV2Json(raw, args = {}) {
  // raw 既接受消息数组本身，也接受 { messages: [...] } 包装（导出再导入的形态）
  const messages = Array.isArray(raw) ? raw : null
  const session = Array.isArray(raw) ? null : (raw && typeof raw === 'object' ? raw : null)
  if (!messages && !(session && Array.isArray(session.messages))) {
    return skipResult('not a Synapse Studio v2 session (no messages array)', { skipped: 1 })
  }
  const list = messages || session.messages

  const sourceId = typeof args.id === 'string' && args.id ? args.id
    : (session && typeof session.id === 'string' && session.id ? session.id : null)
  const rawTitle = typeof args.name === 'string' && args.name ? args.name
    : (session && typeof session.name === 'string' ? session.name : '')
  const title = rawTitle.trim()

  const turnQueue = createTurns()
  const turns = turnQueue.turns
  let cur = null
  const callSteps = new Map()
  let droppedToolResults = 0
  let droppedDuplicateCalls = 0
  let skippedBlocks = 0
  let emptyThinking = 0
  let images = 0
  let imagesDegraded = 0

  const openStep = () => {
    if (!cur) return null
    const step = { content: [], toolCalls: [], toolResults: [] }
    cur.steps.push(step)
    return step
  }
  const attachResult = (step, toolCallId, text, isError) => {
    if (!step) { droppedToolResults++; return }
    step.toolResults.push({
      toolCallId,
      content: text === null || text === undefined ? [] : [{ type: 'text', text }],
      isError: isError === true,
    })
  }

  for (const message of list) {
    if (!message || typeof message !== 'object') continue
    const role = message.role

    if (role === 'user') {
      // 用户侧图片：合法字节进 promptBlocks，拿不到字节的载荷计入 imagesDegraded
      // （宿主层不会收到块，也就没有第二次降级机会——这里必须如实计数）
      let degradedHere = 0
      for (const part of Array.isArray(message.parts) ? message.parts : []) {
        if (!part || part.type !== 'data-image') continue
        if (!partsOf(part).blocks.some((b) => b.type === 'image')) degradedHere++
      }
      imagesDegraded += degradedHere
      const prompt = userPrompt(message)
      if (!prompt.trim() && degradedHere === 0) continue
      cur = turnQueue.open(prompt)
      // 用户贴的截图走 promptBlocks（turn 的用户侧内容块）：合成时优先于纯文本投影，
      // 不必另开 assistant step —— dci 的 events.mjs 就是为「用户贴图提问」设的字段。
      const blocks = imageBlocksOf(message)
      if (blocks.length > 0) cur.promptBlocks = [{ type: 'text', text: prompt }, ...blocks]
      images += blocks.length
      continue
    }

    if (role === 'assistant') {
      const step = openStep()
      if (!step) continue
      for (const part of Array.isArray(message.parts) ? message.parts : []) {
        const r = partsOf(part)
        if (r.thinking && r.blocks.length === 0) { emptyThinking++; continue }
        if (r.degradedImage) imagesDegraded++
        if (r.structural) continue
        if (r.unknown) { skippedBlocks++; continue }
        for (const b of r.blocks) {
          if (b.type === 'text' && b.text === IMAGE_PLACEHOLDER) { imagesDegraded++; continue }
          if (b.type === 'image') images++
          step.content.push(b)
        }
        if (r.tool) {
          const { id, name, input, result, isError } = r.tool
          if (!id) { skippedBlocks++; continue }
          const call = { type: 'tool-call', id, name, arguments: JSON.stringify(input ?? {}) }
          step.content.push(call)
          step.toolCalls.push(call)
          callSteps.set(id, step)
          // v2 的 tool part 自带结果（output / errorText），同一步内直接配对
          attachResult(step, id, result, isError)
        }
      }
      continue
    }
    // 其它 role（实测只有 user / assistant）忽略
  }

  droppedDuplicateCalls = dropDuplicateCalls(turns)
  alignStepResults(turns)

  const sessionId = args.sessionId || mintSessionId(sourceId || args.synapseId)
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: args.createdAt
      ?? (Number.isFinite(args.updatedAt) ? parseTimeMs(args.updatedAt, { truncSeconds: true }) : null)
      ?? Date.now(),
  }
  meta.sourceId = sourceId || sessionId
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : null
  if (cwd) meta.cwd = cwd

  // 空会话（10/47 条 messages 是 []）无轮可导 → 跳过并给出可核对的理由
  if (turns.length === 0) {
    return skipResult('not a Synapse Studio v2 session (no user turns)', { skipped: 1, records: 0 })
  }

  // 标题三级回退：name → 首条用户 prompt → <chat 名> · <日期>。后两级只在导入期可得
  // （messages 整段已在内存里），所以发现层只有前两级。
  const fallback = (typeof args.chatName === 'string' && args.chatName.trim())
    ? args.chatName.trim()
    : 'Synapse Studio v2 会话'
  const stampMs = Number.isFinite(args.updatedAt) ? parseTimeMs(args.updatedAt, { truncSeconds: true }) : null
  const stamp = stampMs === null ? '' : new Date(stampMs).toISOString().slice(0, 10)
  const finalTitle = normalizeTitle(title || turns[0].prompt || (stamp ? fallback + ' · ' + stamp : fallback))

  return finishSession(turns, args.budget, {
    meta,
    title: finalTitle,
    provider: 'synapse-studio-v2',
    // 不写 model：v2 记的是 provider/model 合体别名串，落盘由宿主绑当前默认模型
    skipped: 0,
    records: list.length,
  }, {
    title: finalTitle,
    droppedToolResults,
    droppedDuplicateCalls,
    skippedBlocks,
    emptyThinking,
    images,
    imagesDegraded,
  })
}