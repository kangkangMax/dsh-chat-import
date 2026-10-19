// synapse-studio-v2-import.test.mjs — Synapse Studio v2 的 import_chat 集成测试
//
// 假宿主见 _support/fake-host.mjs；夹具是真实临时 SQLite 库（agentd.db schema），
// 内容全部合成，不掺真实会话。覆盖：一库多会话批量落盘、sessionIds 过滤、幂等短路径、
// 非本库大声报错、快照路径给warning、空会话跳过计数、目录模式定位 data/agents.db。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome, writeSqliteFixture } from './_support/tmp-db.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

const CREATE = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE chats (id TEXT PRIMARY KEY, name TEXT, project_id TEXT, created_at INTEGER, updated_at INTEGER,
  archived_at INTEGER, worktree_path TEXT, branch TEXT, base_branch TEXT);
CREATE TABLE sub_chats (id TEXT PRIMARY KEY, name TEXT, chat_id TEXT, session_id TEXT, mode TEXT,
  messages TEXT NOT NULL DEFAULT '[]', created_at INTEGER, updated_at INTEGER, stream_id TEXT,
  initial_generation_status TEXT, kind TEXT, visibility TEXT);`

const CWD = '/home/u/proj'
const messages = (prompt, reply) => JSON.stringify([
  { id: 'm1', role: 'user', parts: [{ type: 'text', text: prompt }] },
  {
    id: 'm2',
    role: 'assistant',
    parts: [
      { type: 'text', text: reply },
      { type: 'tool-Bash', toolCallId: 'tc1', state: 'output-available', input: { command: 'ls' }, output: { stdout: 'x', stderr: '' } },
    ],
  },
])

function makeDb(dbPath, { subChats = [], chats = null, projects = [] } = {}) {
  return writeSqliteFixture(dbPath, {
    create: CREATE,
    rows: {
      projects: projects.length ? projects : [{ id: 'p1', name: 'proj', path: '/home/u/proj', created_at: 1, updated_at: 2 }],
      chats: chats || [{ id: 'c1', name: '主 chat', project_id: 'p1', created_at: 1760000000, updated_at: 1760000900, archived_at: null, worktree_path: CWD, branch: 'main', base_branch: 'main' }],
      sub_chats: subChats,
    },
  })
}

const subRow = (over = {}) => ({
  id: 'sub-1',
  name: '会话一',
  chat_id: 'c1',
  session_id: 'sess-1',
  mode: 'agent',
  messages: messages('第一个问题', '第一个回答'),
  created_at: 1760000000,
  updated_at: 1760000900,
  stream_id: null,
  initial_generation_status: null,
  kind: 'normal',
  visibility: 'visible',
  ...over,
})

test('import：一库多会话恒批量；每个sub_chat 落一个独立会话', async () => {
  const dbPath = makeDb(join(mkdtempSync(join(tmpdir(), 'syn-import-')), 'data', 'agents.db'), {
    subChats: [subRow(), subRow({ id: 'sub-2', name: '会话二', messages: messages('第二个问题', '第二个回答') })],
  })
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const result = await chatDef(ctx, 'synapse-studio-v2').execute({ path: dbPath })
  assert.equal(result.total, 2)
  assert.equal(result.imported, 2)
  assert.equal(persistence.sessions.size, 2, '两个会话各自落盘，不合并')
})

test('import：sessionIds 过滤只导所选', async () => {
  const dbPath = makeDb(join(mkdtempSync(join(tmpdir(), 'syn-import-')), 'data', 'agents.db'), {
    subChats: [
      subRow(),
      subRow({ id: 'sub-2', name: '会话二' }),
      subRow({ id: 'sub-3', name: '会话三' }),
    ],
  })
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const result = await chatDef(ctx, 'synapse-studio-v2').execute({ path: dbPath, sessionIds: ['sub-2'] })
  assert.equal(result.imported, 1)
  assert.equal(persistence.sessions.size, 1)
})

test('import：幂等 —— 重复导入同一库不产生副本', async () => {
  const dbPath = makeDb(join(mkdtempSync(join(tmpdir(), 'syn-import-')), 'data', 'agents.db'), { subChats: [subRow()] })
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'synapse-studio-v2')
  const first = await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })
  assert.equal(first.imported, 1)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 1)
  assert.equal(persistence.sessions.size, 1)
})

test('import：空 messages 的会话以「无用户回合」跳过并计数，不产生空壳', async () => {
  const dbPath = makeDb(join(mkdtempSync(join(tmpdir(), 'syn-import-')), 'data', 'agents.db'), {
    subChats: [subRow(), subRow({ id: 'sub-empty', name: null, messages: '[]', kind: 'workflow_step', visibility: 'hidden' })],
  })
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const result = await chatDef(ctx, 'synapse-studio-v2').execute({ path: dbPath })
  assert.equal(result.total, 2)
  assert.equal(result.imported, 1)
  assert.ok(result.skipped >= 1, '空会话被跳过')
  assert.equal(persistence.sessions.size, 1)
})

test('import：非本来源的库大声报错（agents.db 是通用文件名）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'syn-bad-'))
  const bogus = join(dir, 'agents.db')
  writeFileSync(bogus, 'not a sqlite db')
  const { ctx } = makeCtx({})
  apply(ctx)
  await assert.rejects(() => chatDef(ctx, 'synapse-studio-v2').execute({ path: bogus }), /Synapse Studio v2/)
})

test('import：快照库（data-backup-*）照常导入但结果带 warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'syn-backup-'))
  const dbPath = makeDb(join(dir, 'data-backup-2.0.0-2026-08-17T02-07', 'agents.db'), { subChats: [subRow()] })
  const { ctx } = makeCtx({})
  apply(ctx)
  const result = await chatDef(ctx, 'synapse-studio-v2').execute({ path: dbPath })
  assert.equal(result.imported, 1, '快照照常导入，不阻断')
  assert.ok(
    (result.warnings || []).some((w) => /data-backup|快照/.test(String(w))),
    '结果里有快照重叠告警：' + JSON.stringify(result.warnings),
  )
})

test('import：目录模式定位 <dir>/agents.db', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'syn-dir-'))
  const dataDir = join(dir, 'data')
  makeDb(join(dataDir, 'agents.db'), { subChats: [subRow()] })
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const result = await chatDef(ctx, 'synapse-studio-v2').execute({ path: dataDir })
  assert.equal(result.imported, 1)
  assert.equal(persistence.sessions.size, 1)
})

test('preview：dry-run 零副作用（有统计、无会话落盘）', async () => {
  const dbPath = makeDb(join(mkdtempSync(join(tmpdir(), 'syn-prev-')), 'data', 'agents.db'), { subChats: [subRow()] })
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const result = await chatDef(ctx, 'synapse-studio-v2').execute({ path: dbPath, preview: true })
  assert.equal(result.preview, true)
  assert.equal(result.total, 1)
  assert.ok(result.results[0].turns > 0, '报告轮数')
  assert.equal(persistence.sessions.size, 0, '预览不落盘')
})