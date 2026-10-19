// lib/sources/synapse-studio-v2.mjs — Synapse Studio v2（agents.db）会话库读取
//
// 读取约定：
//   · 只读打开；签名不符（缺表/缺列）返回 null，发现层据此跳过（不抛错）。`agents.db`
//     是通用文件名，必须靠结构自拒——同一台机器上还存在别的产品也叫 agents.db
//     （如 QwenWorkCN/data/agents.db）。
//   · 签名判定：`sub_chats` 同时具备 `messages` / `chat_id` / `session_id` / `kind` /
//     `visibility` 五列，且 `chats` 具备 `worktree_path` / `project_id` 两列。
//   · **摘要不读 messages**（实测依据见 lib/convert/synapse-studio-v2.mjs 文件头）。
//   · 会话不过滤：`kind` / `visibility` 只用于展示区分，不用于筛除（workflow_step 与空
//     会话由导入期按「无用户回合」跳过并计数）。
//   · cwd 链：`chats.worktree_path` → `projects.path` → null；两者都不可达时由导入层
//     决定是否归入 Legacy。
//
// 存储契约（表结构、消息/part 形状、快照重叠风险）与路径规则在 lib/convert/synapse-studio-v2.mjs，
// 这里只做 host 面读取。

import { readOptionalDb, columnsOf, tableNames } from './sqlite.mjs'
import { synapseUserDataDirs } from '../convert/synapse-studio-v2.mjs'
import { parseTimeMs } from '../convert/core.mjs'

// 路径规则在 lib/convert/（纯函数层）；这里转发给工具层与发现层。
export { synapseUserDataDirs }

// 时间戳是 **Unix 秒**（实测：1788432564 → 2026-09-03，不是 1970）。
// truncSeconds 把秒截到整秒再乘 1000；非有限值/脏值 → null，不虚构时间。
function synapseMs(v) {
  return typeof v === 'number' ? parseTimeMs(v, { truncSeconds: true }) : null
}

// 库签名 + 会话摘要行（签名不符 → null；打不开 / 损坏 / 锁定由 readOptionalDb 归一为 null）。
function synapseSummaryRows(db) {
  const tables = tableNames(db)
  if (!tables.has('sub_chats') || !tables.has('chats')) return null
  const subCols = columnsOf(db, 'sub_chats')
  const chatCols = columnsOf(db, 'chats')
  const ok = subCols.has('messages') && subCols.has('chat_id') && subCols.has('session_id')
    && subCols.has('kind') && subCols.has('visibility')
    && chatCols.has('worktree_path') && chatCols.has('project_id')
  if (!ok) return null
  // 摘要查询刻意不SELECT messages：单列 TEXT 存整段 JSON，任何派生表达式
  // （length / json_extract）都会把整列载入。
  const rows = db.prepare(`SELECT s.id, s.name, s.kind, s.visibility, s.created_at, s.updated_at,
      c.name AS chat_name, c.worktree_path, p.path AS project_path
    FROM sub_chats s
    LEFT JOIN chats c ON c.id = s.chat_id
    LEFT JOIN projects p ON p.id = c.project_id
    ORDER BY s.updated_at DESC`).all()
  return { rows, hasProjects: tables.has('projects') }
}

// summary 回退链：name → <chat 名> · <日期>（发现层只有两级，见文件头「首条用户文本的兜底
// 标题由导入期承担」）。workflow_step 加前缀，用户在勾选时就知道这条是什么。
function summaryTitle(row) {
  const name = typeof row.name === 'string' ? row.name.trim() : ''
  const chat = typeof row.chat_name === 'string' ? row.chat_name.trim() : ''
  let base = name
  if (!base) {
    const ms = synapseMs(row.updated_at)
    const stamp = ms === null ? '' : new Date(ms).toISOString().slice(0, 10)
    base = chat ? (stamp ? `${chat} · ${stamp}` : chat) : 'Synapse Studio v2 会话'
  }
  return row.kind === 'workflow_step' ? `[工作流] ${base}` : base
}

/** Synapse Studio v2 库 → 会话摘要数组（发现层用，不读消息体）。非该来源的库/读不到 → null。 */
export function readSynapseStudioV2Summaries(dbPath) {
  return readOptionalDb(dbPath, synapseSummaryRows, (_db, read) => read.rows.map((row) => ({
    id: row.id,
    title: summaryTitle(row),
    // worktree_path 优先，回退 projects.path；都空则 null（导入期按 Legacy 处理）
    directory: row.worktree_path || row.project_path || null,
    createdAt: synapseMs(row.created_at) ?? undefined,
    lastActiveAt: synapseMs(row.updated_at) ?? undefined,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
    visibility: typeof row.visibility === 'string' ? row.visibility : undefined,
  })))
}