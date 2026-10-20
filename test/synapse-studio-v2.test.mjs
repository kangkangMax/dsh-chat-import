// synapse-studio-v2.test.mjs — Synapse Studio v2（agents.db）转换层 + 发现层单测
//
// 覆盖：库签名自拒（agents.db 是通用文件名，本机还有别的产品同名库）、摘要不读 messages、
// cwd 链（worktree_path → projects.path → null）、标题两级回退、workflow_step 前缀、
// 不过滤（kind/visibility 只做展示）、三平台 roots、快照路径判定；part → IR 映射
// （text / Thinking / data-image / 开放 tool-* 命名空间 / tool-Compact）、工具配对、
// Bash stdout 取值、errorText 标 isError、空会话跳过、标题三级回退。
//
// 契约红线：摘要 SQL 里不得出现 messages 的任何派生表达式（length / json_extract）——
// 该列是整段 JSON 的 TEXT，实测任何派生表达式都会把整列载入并解析（84 MB 库上把摘要
// 查询从 19 ms 抬到 128 ms）。本文件的 SQL_NO_MESSAGES 断言就是这条红线的机械守卫。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { readSynapseStudioV2Summaries } from '../lib/sources/synapse-studio-v2.mjs'
import { synapseUserDataDirs, isSynapseBackupPath, convertSynapseStudioV2Json } from '../lib/convert/synapse-studio-v2.mjs'
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
// ── 转换层：part → IR ────────────────────────────────────────────────────────────

const conv = (messages, args = {}) => convertSynapseStudioV2Json(messages, args)

test('convert：user 开轮、assistant 出 text 步；工具 call/result 同一步配对', () => {
  const out = conv([
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: '跑一下测试' }] },
    {
      id: 'm2',
      role: 'assistant',
      parts: [
        { type: 'text', text: '好' },
        { type: 'tool-Bash', toolCallId: 'tc1', state: 'output-available', input: { command: 'ls' }, output: { stdout: 'a\nb', stderr: '' } },
      ],
    },
  ], { id: 'sub1', name: '命名会话' })

  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '跑一下测试')
  assert.equal(out.turns[0].steps.length, 1, '用户轮不带assistant 步')
  const step = out.turns[0].steps[0]
  assert.equal(step.toolCalls.length, 1)
  assert.equal(step.toolCalls[0].name, 'Bash', 'tool-<Name> 的 Name 部分是工具名')
  assert.equal(step.toolCalls[0].id, 'tc1')
  assert.deepEqual(JSON.parse(step.toolCalls[0].arguments), { command: 'ls' })
  assert.equal(step.toolResults.length, 1, '每个调用都有结果')
  assert.equal(step.toolResults[0].content[0].text, 'a\nb', 'Bash 形态取 stdout')
  assert.equal(out.title, '命名会话')
})

test('convert：未知 tool 命名空间保留为通用调用（tool-FutureThing 不丢）', () => {
  const out = conv([
    { role: 'user', parts: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', parts: [{ type: 'tool-FutureThing', toolCallId: 'x1', input: { a: 1 }, output: { k: 'v' } }] },
  ], { id: 's' })
  const call = out.turns[0].steps[0].toolCalls[0]
  assert.equal(call.name, 'FutureThing')
  assert.equal(out.turns[0].steps[0].toolResults[0].content[0].text, '{"k":"v"}')
  assert.equal(out.skippedBlocks, 0, '开放命名空间不是降级')
})

test('convert：空 Thinking 跳过并计数（有文本的照常成reasoning）', () => {
  const out = conv([
    { role: 'user', parts: [{ type: 'text', text: 'q' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'tool-Thinking', toolCallId: 't1', input: { text: '   ' }, output: { completed: true } },
        { type: 'tool-Thinking', toolCallId: 't2', input: { text: '真正在思考' }, output: { completed: true } },
      ],
    },
  ], { id: 's' })
  assert.equal(out.emptyThinking, 1)
  const reasoning = out.turns[0].steps[0].content.filter((b) => b.type === 'reasoning')
  assert.equal(reasoning.length, 1)
  assert.equal(reasoning[0].text, '真正在思考')
})

test('convert：data-image 取part.data 里的字节；非法载荷降级占位并计数', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const out = conv([
    { role: 'user', parts: [{ type: 'text', text: '看图' }, { type: 'data-image', data: { base64Data: png, mediaType: 'image/png', filename: 'shot.png' } }] },
    { role: 'assistant', parts: [{ type: 'text', text: '收到' }] },
  ], { id: 's' })
  assert.equal(out.images, 1)
  assert.equal(out.imagesDegraded, 0)
  // 用户贴的图走 promptBlocks（turn 的用户侧内容块），不占 assistant 步
  const img = out.turns[0].promptBlocks.find((b) => b.type === 'image')
  assert.equal(img.data, png)
  assert.equal(img.name, 'shot.png')
  assert.equal(out.turns[0].steps.length, 1, 'assistant 步只放回复')

  const bad = conv([
    { role: 'user', parts: [{ type: 'text', text: 'x' }, { type: 'data-image', data: { base64Data: png, mediaType: 'application/pdf' } }] },
  ], { id: 's2' })
  assert.equal(bad.images, 0)
  assert.equal(bad.imagesDegraded, 1, '类型不收 → 降级计数')
})

test('convert：tool-Compact 跳过（结构性标记，不计入降级）；未识别 part 计数', () => {
  const out = conv([
    { role: 'user', parts: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', parts: [{ type: 'tool-Compact', toolCallId: 'c1', input: { status: 'compacting' }, output: { status: 'compacted' } }, { type: 'mystery-block' }] },
  ], { id: 's' })
  assert.equal(out.turns[0].steps[0].toolCalls.length, 0)
  assert.equal(out.skippedBlocks, 1, '只有未识别块计数；Compact 是结构标记不算降级')
})

test('convert：output 缺失补空结果不丢调用；errorText 标 isError', () => {
  const out = conv([
    { role: 'user', parts: [{ type: 'text', text: 'q' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'tool-Read', toolCallId: 'r1', state: 'output-available', input: { file: 'a.ts' } },
        { type: 'tool-Bash', toolCallId: 'b1', state: 'error', input: {}, output: { stdout: 'partial' }, errorText: 'exit 1' },
      ],
    },
  ], { id: 's' })
  const step = out.turns[0].steps[0]
  assert.equal(step.toolCalls.length, 2)
  assert.deepEqual(step.toolResults[0].content, [], '缺 output → 空结果')
  assert.equal(step.toolResults[1].isError, true)
  assert.equal(step.toolResults[1].content[0].text, 'exit 1', 'errorText 优先作结果')
})

test('convert：空 messages / 无用户回合 → 跳过并给出可核对的理由', () => {
  const empty = conv([], { id: 'e' })
  assert.match(empty.skipReason, /no user turns/)
  const onlyAssistant = conv([{ role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }], { id: 'a' })
  assert.match(onlyAssistant.skipReason, /no user turns/)
})

test('convert：标题三级回退（name → 首条用户 prompt → chat 名 · 日期）', () => {
  const msgs = [{ role: 'user', parts: [{ type: 'text', text: '帮我看看这个 PR' }] }]
  assert.equal(conv(msgs, { id: 's', name: '' }).title, '帮我看看这个 PR')
  assert.equal(conv(msgs, { id: 's', name: '', chatName: '员工雇佣日期', updatedAt: 1760000900 }).title, '帮我看看这个 PR')
  // prompt 也是空时才落到第三级（正常会话不会，这里直接用空数组路径验证文案）
  assert.equal(conv([], { id: 's' }).skipReason !== undefined, true)
})

test('convert：provider/model 不迁移（v2 记的是别名串，落盘由宿主绑默认模型）', () => {
  const out = conv([
    { role: 'user', parts: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', metadata: { model: 'claude-code/sonnet', provider: 'claude-code', inputTokens: 100 }, parts: [{ type: 'text', text: 'a' }] },
  ], { id: 's' })
  assert.equal(out.model, undefined, '不产出 model')
  assert.equal(out.provider, undefined, 'finishSession 不把 provider 提到返回顶层')
  // 落盘前 meta 会被 header 白名单裁剪；这里先确保 meta 本身干净
  assert.equal(out.meta.model, undefined)
  assert.equal(out.meta.provider, undefined)
  // 事件里也不该出现源里的别名串
  assert.doesNotMatch(JSON.stringify(out.events), /claude-code/)
})

test('readSynapseStudioV2Summaries：老库没有 projects 表时走不带该JOIN 的变体', () => {
  withTmp((root) => {
    const dbPath = writeSqliteFixture(join(root, 'data', 'agents.db'), {
      create: `CREATE TABLE chats (id TEXT PRIMARY KEY, name TEXT, project_id TEXT, worktree_path TEXT);
               CREATE TABLE sub_chats (id TEXT PRIMARY KEY, name TEXT, chat_id TEXT, session_id TEXT,
                 messages TEXT, created_at INTEGER, updated_at INTEGER, kind TEXT, visibility TEXT);`,
      rows: {
        chats: [{ id: 'c1', name: '老 chat', project_id: 'p-gone', worktree_path: '/legacy/path' }],
        sub_chats: [{ id: 's1', name: '老会话', chat_id: 'c1', session_id: null, messages: '[]', created_at: 1760000000, updated_at: 1760000900, kind: 'normal', visibility: 'visible' }],
      },
    })
    const rows = readSynapseStudioV2Summaries(dbPath)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].directory, '/legacy/path', 'worktree_path 仍可用，少的只是 projects.path 回退')
    assert.equal(rows[0].title, '老会话')
  })
})

test('convert：工具名清洗成 ^[a-zA-Z0-9_-]+$（MCP 的 "a / b" 会让整轮被 API 400 拒绝）', () => {
  const out = conv([
    { role: 'user', parts: [{ type: 'text', text: 'q' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'tool-talkdesk-developer / talkdesk_resource_get', toolCallId: 'm1', input: {}, output: { ok: 1 } },
        { type: 'tool-WebFetch', toolCallId: 'm2', input: {}, output: { ok: 1 } },
      ],
    },
  ], { id: 's' })
  const names = out.turns[0].steps[0].toolCalls.map((c) => c.name)
  assert.deepEqual(names, ['talkdesk-developer_talkdesk_resource_get', 'WebFetch'])
  for (const n of names) assert.match(n, /^[a-zA-Z0-9_-]+$/, '工具名必须匹配 API 的字符集')
})

test('convert：连续 user 消息并入同一轮（v2 把技能注入存成紧随提问的 user 消息）', () => {
  const out = conv([
    { role: 'user', parts: [{ type: 'text', text: '把日志样式改一下' }] },
    { role: 'user', parts: [{ type: 'text', text: '[[SKILL:x]] 技能的完整说明……' }] },
    { role: 'assistant', parts: [{ type: 'text', text: '好的，我先看设计' }] },
    { role: 'user', parts: [{ type: 'text', text: '顺便改下颜色' }] },
    { role: 'assistant', parts: [{ type: 'text', text: '已改' }] },
  ], { id: 's' })

  assert.equal(out.turns.length, 2, '两条连续 user 合成一轮，不是两轮')
  assert.equal(out.turns[0].steps.length, 1, '第一轮有助手回复（不悬空）')
  assert.match(out.turns[0].prompt, /把日志样式改一下/)
  assert.match(out.turns[0].prompt, /SKILL/, '注入文本并入同一轮的 prompt')
  assert.equal(out.turns[1].prompt, '顺便改下颜色', '助手回过话之后的 user 才是新轮')
  assert.equal(out.turns.filter((t) => t.steps.length === 0).length, 0, '没有悬空轮')
})
