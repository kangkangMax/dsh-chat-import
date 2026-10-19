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

import { readOptionalDb, columnsOf, tableNames, locateDbInDirectory } from './sqlite.mjs'
import { synapseUserDataDirs, isSynapseBackupPath } from '../convert/synapse-studio-v2.mjs'
import { convertSynapseStudioV2Json } from '../convert/index.mjs'
import { parseTimeMs } from '../convert/core.mjs'
import { sessionSelection } from '../import-state.mjs'
import { importMultiSource, convertSessionItems, previewSessionSet, selectionSet } from '../import-core.mjs'

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
  return { tables, subCols, chatCols }
}

// 摘要查询（**刻意不 SELECT messages**：单列 TEXT 存整段 JSON，任何派生表达式都会把
// 整列载入 —— 实测 json_extract 让这条查询从 19 ms 涨到 128 ms）。
//
// 投影列与 JOIN 必须成对增减：老库没有 projects 表时走无 projects 的变体；只去 JOIN 而
// 留着 `p.path` 投影会报 no such column: p.path（已踩过）。
const SUMMARY_SELECT = `SELECT s.id, s.name, s.kind, s.visibility, s.created_at, s.updated_at,
    c.name AS chat_name, c.worktree_path`

const SUMMARY_SQL = `${SUMMARY_SELECT}, p.path AS project_path
  FROM sub_chats s
  LEFT JOIN chats c ON c.id = s.chat_id
  LEFT JOIN projects p ON p.id = c.project_id
  ORDER BY s.updated_at DESC`

const SUMMARY_SQL_NO_PROJECTS = `${SUMMARY_SELECT}
  FROM sub_chats s
  LEFT JOIN chats c ON c.id = s.chat_id
  ORDER BY s.updated_at DESC`

function summaryQuery(db) {
  return tableNames(db).has('projects') ? SUMMARY_SQL : SUMMARY_SQL_NO_PROJECTS
}

// 全量读取（导入用）：多取 messages 一列，其余同摘要。会话级 cwd 走 worktree_path →
// projects.path（读取期就定好，转换器不再猜）。
function synapseAllRows(db) {
  const sig = synapseSummaryRows(db)
  if (!sig) return null
  const hasProjects = sig.tables.has('projects')
  const selectTail = hasProjects ? ', p.path AS project_path' : ''
  const joinTail = hasProjects ? '\n    LEFT JOIN projects p ON p.id = c.project_id' : ''
  return db.prepare(`SELECT s.id, s.name, s.kind, s.messages, s.created_at, s.updated_at,
      c.name AS chat_name, c.worktree_path${selectTail}
    FROM sub_chats s
    LEFT JOIN chats c ON c.id = s.chat_id${joinTail}
    ORDER BY s.updated_at DESC`).all()
}

// messages 那一列是整段 JSON 文本：畸形 / 非数组 → [] （该会话仍参与导入，按「无用户回合」跳过）
function parseMessages(raw) {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
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
  return readOptionalDb(dbPath, synapseSummaryRows, (db, _sig) => db.prepare(summaryQuery(db)).all().map(summaryOf))
}

function summaryOf(row) {
  return {
    id: row.id,
    title: summaryTitle(row),
    // worktree_path 优先，回退 projects.path；都空则 null（导入期按 Legacy 处理）
    directory: row.worktree_path || row.project_path || null,
    createdAt: synapseMs(row.created_at) ?? undefined,
    lastActiveAt: synapseMs(row.updated_at) ?? undefined,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
    visibility: typeof row.visibility === 'string' ? row.visibility : undefined,
  }
}

/**
 * Synapse Studio v2 库 → 全部会话（导入用，含消息体）。非该来源的库/读不到 → null。
 *
 * 注意体积：47 条会话的 messages 合计 84 MB，最大单条 24.6 MB —— 整库导入会把这些全部
 * 载入内存。调用方（importMultiSource）按 sessionIds 过滤是在**载入之后**做的，所以
 * 「只导 3 条」同样要付整库读的成本。这是 SQLite 单列存整段 JSON 的固有代价，不在读取
 * 层规避（改成按需分页会与「一个sub_chat 一段 JSON」的存储形状打架）。
 */
export function readSynapseStudioV2Db(dbPath) {
  return readOptionalDb(dbPath, synapseSummaryRows, (db, _sig) => synapseAllRows(db).map((row) => ({
    ...summaryOf(row),
    name: typeof row.name === 'string' ? row.name : '',
    cwd: row.worktree_path || row.project_path || null,
    createdAt: synapseMs(row.created_at),
    updatedAt: synapseMs(row.updated_at),
    messages: parseMessages(row.messages),
  })))
}

const NOT_SYNAPSE_DB = 'Not a Synapse Studio v2 database (no sub_chats/chats with messages+chat_id+worktree_path): '

function readSynapseStudioV2DbOrThrow(path) {
  const sessions = readSynapseStudioV2Db(path)
  if (!sessions) throw new Error(NOT_SYNAPSE_DB + path)
  return sessions
}

// 单会话转换：会话级元信息（id / name / cwd / 时间 / chat 名）经 args 带进纯函数。
const synapseConvertOne = (args, path) => (s) => convertSynapseStudioV2Json(s.messages, {
  ...args,
  id: s.id,
  name: s.name,
  cwd: s.cwd,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  chatName: typeof args.synapseChatName === 'string' ? args.synapseChatName : '',
  synapseId: s.id,
  sourcePath: path,
})

// 库里每个会话独立落盘（sessionIds 过滤 + 库指纹 / WAL 短路径 + 逐会话 append）。
export async function importSynapseStudioV2File(ctx, target, args, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const selection = sessionSelection(args)
  const path = target.displayPath || ctx.fs.processPath(target)
  // 快照库（data-backup-*）的会话集合是主库的真子集：导入会与已有会话重复，而 registry
  // 以路径为键判不出重。照常导入，但在结果里如实警告（不静默、不阻断）。
  const backupWarning = isSynapseBackupPath(path)
    ? 'Synapse Studio v2 历史快照（data-backup-*）：其会话与主库重叠，导入会产生重复会话'
    : null
  const result = await importMultiSource(ctx, target, args, {
    registryDir, persisted, fingerprintKeys, sqlite: true, selection, importFormat: 'synapse-studio-v2',
    load: (p) => convertSessionItems(ctx, readSynapseStudioV2DbOrThrow(p), {
      path: p, args, wanted: selectionSet(selection), sourceLabel: 'Synapse Studio v2',
      convertOne: synapseConvertOne(args, p),
    }),
  })
  if (backupWarning && result && typeof result === 'object') {
    const warnings = Array.isArray(result.warnings) ? result.warnings.slice() : []
    warnings.push(backupWarning)
    result.warnings = warnings
  }
  return result
}

// 目录里的库：`<dir>/agents.db`（<dir> 通常是 <userData>/data）。**不扫 data-backup-***
// ——快照目录是 <userData>/data-backup-*，与 data/ 平级，目录模式只认 data/ 下这一层。
export async function importSynapseStudioV2Directory(ctx, dirTarget, args, options = {}) {
  const path = await locateDbInDirectory(ctx, dirTarget, [['agents.db']], ['agents.db'])
  return importSynapseStudioV2File(ctx, path, args, options)
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

export async function previewSynapseStudioV2File(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sessions = readSynapseStudioV2DbOrThrow(path)
  const results = previewSessionSet(sessions, {
    path, args, wanted: selectionSet(sessionSelection(args)), sourceLabel: 'Synapse Studio v2',
    convertOne: synapseConvertOne(args, path),
  })
  return { total: sessions.length, results }
}

export async function previewSynapseStudioV2Directory(ctx, dirTarget, args) {
  return previewSynapseStudioV2File(ctx, await locateDbInDirectory(ctx, dirTarget, [['agents.db']], ['agents.db']), args)
}