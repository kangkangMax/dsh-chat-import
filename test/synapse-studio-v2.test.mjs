// synapse-studio-v2.test.mjs — Synapse Studio v2（agents.db）发现层读取单测
//
// 覆盖：库签名自拒（agents.db 是通用文件名，本机还有别的产品同名库）、摘要不读 messages、
// cwd 链（worktree_path → projects.path → null）、标题两级回退、workflow_step 前缀、
// 不过滤（kind/visibility 只做展示）、三平台 roots、快照路径判定。
//
// 契约红线：摘要 SQL 里不得出现 messages 的任何派生表达式（length / json_extract）——
// 该列是整段 JSON 的 TEXT，实测任何派生表达式都会把整列载入并解析（84 MB 库上把摘要
// 查询从 19 ms 抬到 128 ms）。本文件的 SQL_NO_MESSAGES 断言就是这条红线的机械守卫。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { readSynapseStudioV2Summaries } from '../lib/sources/synapse-studio-v2.mjs'
import { synapseUserDataDirs, isSynapseBackupPath } from '../lib/convert/synapse-studio-v2.mjs'
import { sourceOf, FORMATS, defaultRoots } from '../lib/discovery/registry.mjs'
import { withTempDir, writeSqliteFixture } from './_support/tmp-db.mjs'

// 本机实测库的列定义（synapse-studio v2）。列名逐字照抄，缺一列就该自拒。
const CREATE = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, created_at INTEGER,
  updated_at INTEGER, git_remote_url TEXT, git_provider TEXT, git_owner TEXT, git_repo TEXT, icon_path TEXT);
CREATE TABLE chats (id TEXT PRIMARY KEY, name TEXT, project_id TEXT, created_at INTEGER,
  updated_at INTEGER, archived_at INTEGER, worktree_path TEXT, branch TEXT, base_branch TEXT,
  pr_url TEXT, pr_number INTEGER, workflow_mode TEXT, persona_id TEXT, sidebar_status_json TEXT,
  uses_worktree INTEGER, pr_state_cache TEXT, pr_state_cached_at INTEGER, work_project_id TEXT);
CREATE TABLE sub_chats (id TEXT PRIMARY KEY, name TEXT, chat_id TEXT, session_id TEXT, mode TEXT,
  messages TEXT NOT NULL DEFAULT '[]', created_at INTEGER, updated_at INTEGER, stream_id TEXT,
  initial_generation_status TEXT, kind TEXT, visibility TEXT);`

const withTmp = (fn) => withTempDir('synapse-v2-test-', fn)

function makeDb(dbPath, { chats = [], subChats = [], projects = [], create = CREATE } = {}) {
  return writeSqliteFixture(dbPath, {
    create,
    rows: { chats, sub_chats: subChats, projects },
  })
}

const CHAT = { id: 'chat-1', name: '员工雇佣日期', project_id: 'proj-1', created_at: 1760000000, updated_at: 1760000900, archived_at: null, worktree_path: '/Users/u/repo/.worktrees/hire', branch: 'feat/x', base_branch: 'main' }
const MSG = JSON.stringify([{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }])

test('readSynapseStudioV2Summaries：47 条全列、cwd 取 worktree_path、不过滤 workflow_step', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'data', 'agents.db'), {
      projects: [{ id: 'proj-1', name: 'wfm', path: '/Users/u/repo', created_at: 1, updated_at: 2, git_remote_url: null, git_provider: null, git_owner: null, git_repo: null, icon_path: null }],
      chats: [CHAT],
      subChats: [
        { id: 'sub-visible', name: 'Add CSV import', chat_id: 'chat-1', session_id: 'sess-1', mode: 'agent', messages: MSG, created_at: 1760000000, updated_at: 1760000900, stream_id: null, initial_generation_status: null, kind: 'normal', visibility: 'visible' },
        { id: 'sub-step', name: 'run step', chat_id: 'chat-1', session_id: null, mode: 'agent', messages: MSG, created_at: 1760000000, updated_at: 1760000800, stream_id: null, initial_generation_status: null, kind: 'workflow_step', visibility: 'hidden' },
        { id: 'sub-empty', name: null, chat_id: 'chat-1', session_id: null, mode: 'agent', messages: '[]', created_at: 1760000000, updated_at: 1760000700, stream_id: null, initial_generation_status: null, kind: 'workflow_step', visibility: 'hidden' },
      ],
    })
    const rows = readSynapseStudioV2Summaries(dbPath)
    assert.equal(rows.length, 3, '会话不过滤：normal / workflow_step / 空 messages 全部列出')
    const byId = new Map(rows.map((r) => [r.id, r]))
    assert.equal(byId.get('sub-visible').title, 'Add CSV import')
    assert.equal(byId.get('sub-visible').directory, '/Users/u/repo/.worktrees/hire', 'cwd 优先 worktree_path')
    assert.match(byId.get('sub-step').title, /^\[工作流\] /, 'workflow_step 加前缀')
    // 空标题回退：name 为 null → <chat 名> · <日期>
    assert.equal(byId.get('sub-empty').title, `[工作流] ${CHAT.name} · 2025-10-09`)
  })
})

test('时间戳是 Unix 秒不是毫秒（按毫秒解会全部落到 1970 年）', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'data', 'agents.db'), {
      chats: [CHAT],
      subChats: [{ id: 's', name: 'n', chat_id: 'chat-1', session_id: null, mode: 'agent', messages: MSG, created_at: 1760000000, updated_at: 1788432564, stream_id: null, initial_generation_status: null, kind: 'normal', visibility: 'visible' }],
    })
    const row = readSynapseStudioV2Summaries(dbPath)[0]
    assert.equal(row.createdAt, 1760000000000, '秒 × 1000 → 毫秒')
    assert.equal(row.lastActiveAt, 1788432564000)
    assert.equal(new Date(row.lastActiveAt).getUTCFullYear(), 2026)
  })
})

test('脏时间戳（非数字 / 非有限）归一为 undefined，不虚构时间', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'data', 'agents.db'), {
      chats: [CHAT],
      subChats: [{ id: 's', name: 'n', chat_id: 'chat-1', session_id: null, mode: 'agent', messages: MSG, created_at: null, updated_at: null, stream_id: null, initial_generation_status: null, kind: 'normal', visibility: 'visible' }],
    })
    const row = readSynapseStudioV2Summaries(dbPath)[0]
    assert.equal(row.createdAt, undefined)
    assert.equal(row.lastActiveAt, undefined)
    assert.equal(row.title, 'n', '有 name 时标题不受时间戳影响')
  })
})

test('readSynapseStudioV2Summaries：worktree_path 缺失时回退 projects.path；两者都空则 null', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'data', 'agents.db'), {
      projects: [{ id: 'proj-1', name: 'wfm', path: '/Users/u/repo', created_at: 1, updated_at: 2, git_remote_url: null, git_provider: null, git_owner: null, git_repo: null, icon_path: null }],
      chats: [
        { ...CHAT, id: 'c-fallback', worktree_path: null },
        { ...CHAT, id: 'c-bare', project_id: null, worktree_path: null },
      ],
      subChats: [
        { id: 's-fallback', name: 'a', chat_id: 'c-fallback', session_id: null, mode: 'agent', messages: MSG, created_at: 1, updated_at: 2, stream_id: null, initial_generation_status: null, kind: 'normal', visibility: 'visible' },
        { id: 's-bare', name: 'b', chat_id: 'c-bare', session_id: null, mode: 'agent', messages: MSG, created_at: 1, updated_at: 2, stream_id: null, initial_generation_status: null, kind: 'normal', visibility: 'visible' },
      ],
    })
    const rows = readSynapseStudioV2Summaries(dbPath)
    const byId = new Map(rows.map((r) => [r.id, r]))
    assert.equal(byId.get('s-fallback').directory, '/Users/u/repo', 'worktree_path 空 → projects.path')
    assert.equal(byId.get('s-bare').directory, null, '两者都不可达 → null（导入期才决定 Legacy）')
  })
})

// 红线守卫：摘要 SQL 不得触碰 messages。派生表达式会强制整列载入。
const SQL_NO_MESSAGES = /\blength\s*\(\s*[a-z_.]*messages|json_(extract|array_length)\s*\(\s*[a-z_.]*messages|SELECT\s+\*|,\s*messages\b/i

test('摘要 SQL 不含 messages 的任何派生表达式（84 MB 库上 19 ms 与 128 ms 的差别）', () => {
  const src = readFileSync(new URL('../lib/sources/synapse-studio-v2.mjs', import.meta.url), 'utf8')
  const sql = src.match(/SELECT[\s\S]*?ORDER BY s\.updated_at DESC/i)
  assert.ok(sql, `能找到摘要 SQL（实际片段：${String(src.match(/SELECT[\s\S]{0,80}/i)).slice(0, 90)}）`)
  assert.doesNotMatch(sql[0], SQL_NO_MESSAGES, '摘要 SQL 出现 messages 派生表达式')
  assert.match(sql[0], /FROM\s+sub_chats/, '摘要查 sub_chats')
})

test('readSynapseStudioV2Summaries：非本来源的 agents.db 返回 null（同名文件自拒）', () => {
  withTmp((root) => {
    // 同名不同库：别的产品也叫 agents.db，结构里没有 sub_chats / worktree_path
    const other = writeSqliteFixture(join(root, 'data', 'agents.db'), {
      create: 'CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);',
      rows: { tasks: [{ id: 't1', title: 'x' }] },
    })
    assert.equal(readSynapseStudioV2Summaries(other), null)

    // 结构对但缺关键列 → 同样自拒
    const missingCol = writeSqliteFixture(join(root, 'data', 'other.db'), {
      create: `CREATE TABLE sub_chats (id TEXT PRIMARY KEY, messages TEXT);
               CREATE TABLE chats (id TEXT PRIMARY KEY, worktree_path TEXT);`,
      rows: { sub_chats: [{ id: 's', messages: '[]' }], chats: [{ id: 'c', worktree_path: '/x' }] },
    })
    assert.equal(readSynapseStudioV2Summaries(missingCol), null, '缺 chat_id / session_id / kind / visibility 列 → 自拒')
  })
})

test('readSynapseStudioV2Summaries：打不开的路径返回 null，不抛错', () => {
  withTmp((root) => {
    assert.equal(readSynapseStudioV2Summaries(join(root, 'nope', 'agents.db')), null)
  })
})

test('synapseUserDataDirs：三平台路径各自正确，win32 缺 APPDATA 返回空数组', () => {
  const home = join('home', 'u')
  assert.deepEqual(synapseUserDataDirs(home, {}, 'linux'), [
    join(home, '.config', 'Synapse Studio', 'data', 'agents.db'),
    join(home, '.config', 'Synapse Studio Dev', 'data', 'agents.db'),
  ])
  assert.deepEqual(synapseUserDataDirs(home, { XDG_CONFIG_HOME: join(home, 'cfg') }, 'linux'), [
    join(home, 'cfg', 'Synapse Studio', 'data', 'agents.db'),
    join(home, 'cfg', 'Synapse Studio Dev', 'data', 'agents.db'),
  ])
  assert.deepEqual(synapseUserDataDirs(home, { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'), [
    join('C:\\Users\\u\\AppData\\Roaming', 'Synapse Studio', 'data', 'agents.db'),
    join('C:\\Users\\u\\AppData\\Roaming', 'Synapse Studio Dev', 'data', 'agents.db'),
  ])
  assert.deepEqual(synapseUserDataDirs(home, {}, 'win32'), [], 'win32 缺 APPDATA → 无默认根')
  assert.deepEqual(synapseUserDataDirs(home, {}, 'darwin'), [
    join(home, 'Library', 'Application Support', 'Synapse Studio', 'data', 'agents.db'),
    join(home, 'Library', 'Application Support', 'Synapse Studio Dev', 'data', 'agents.db'),
  ])
})

test('isSynapseBackupPath：只认 data-backup-* 快照目录，不误伤主库路径', () => {
  assert.equal(isSynapseBackupPath('/Users/u/App/Synapse Studio Dev/data-backup-2.0.0-2026-08-17/data/agents.db'), true)
  assert.equal(isSynapseBackupPath('C:\\u\\App\\Synapse Studio Dev\\data-backup-1.14.0-x\\data\\agents.db'), true)
  assert.equal(isSynapseBackupPath('/Users/u/App/Synapse Studio Dev/data/agents.db'), false)
  assert.equal(isSynapseBackupPath(''), false)
})

test('发现层登记：描述符存在、sessionsFromHost 与摘要读取器对账', () => {
  const src = sourceOf('synapse-studio-v2')
  assert.ok(src, '描述符已登记进 registry')
  assert.equal(src.sessionsFromHost, true)
  assert.ok(FORMATS.includes('synapse-studio-v2'), 'FORMATS 顺序表含本来源')
  // agents.db 是通用文件名：只能是候选，绝不能独占
  assert.equal(src.matchFile('/x/data/agents.db'), true)
  assert.deepEqual(src.fileFallback, ['db'])
  assert.ok(Array.isArray(defaultRoots({ home: '/h' })['synapse-studio-v2']), 'roots 是路径数组（产品名多变体）')
})