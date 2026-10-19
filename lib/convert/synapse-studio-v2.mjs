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