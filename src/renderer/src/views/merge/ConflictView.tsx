import { Alert, Button, Space, Tabs, Tag } from 'antd'
import * as monaco from 'monaco-editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ResolveFileParam, SyncFileConflict } from '../../../../shared/ipc'
import { isJsonSyncFile, syncFileLabel } from '../../../../shared/sync-files'
import { BEANCOUNT_LANGUAGE_ID, monacoThemeForMode, registerBeancountLanguage } from '../../monaco/beancount-language'
import { JSON_LANGUAGE_ID, registerJsonLanguage } from '../../monaco/json-language'
import { useSyncStore } from '../../stores/sync'
import { useThemeContext } from '../../theme/ThemeProvider'

registerBeancountLanguage(monaco) // 模块级注册一次（幂等，M5）
registerJsonLanguage(monaco) // M11：受同步管理的 JSON 文件高亮（自注册 monarch，零 worker 依赖）

type Decision = 'ours' | 'theirs'

/**
 * M6/M11：多文件三路合并视图。
 *
 * 逐文件 tab（账本 / 账户库 / Excel 模板 / .gitignore）：
 * - **文本文件**（账本等）：上双 DiffEditor（ours / theirs 只读对比）+ 下 merged 可编辑 Monaco，
 *   三按钮「采用本地 / 采用远端 / 完成合并」；合并结果校验失败 → merged 保留供修改（不丢内容）。
 * - **JSON 文件**（账户库 / Excel 模板）：只读双栏对比 + 仅「采用本地 / 采用远端」二选一
 *   （不做手工编辑 JSON；走到这一步说明两侧都改了同一条目，自动并集无能为力）。
 *   JSON 的决议必须显式选择——默认不选，全部选完「完成合并」才可用（避免误点丢一边）。
 *
 * merged 编辑器**无条件挂载**（C-1 不变式：早期版本因 conflict 为空即早退，导致创建 effect 依赖 []
 * 永不重跑、编辑器永不出现）；非文本 tab 时用 display 隐藏而非卸载。
 */
export default function ConflictView() {
  const conflict = useSyncStore((s) => s.conflict)
  const syncing = useSyncStore((s) => s.syncing)
  const resolveConflict = useSyncStore((s) => s.resolveConflict)
  const { mode } = useThemeContext()

  const diffRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const activePathRef = useRef<string>('')

  const [activePath, setActivePath] = useState('')
  /** 文本文件的手工合并稿（path → 内容；初始为 ours，本地优先——与 M5 冲突面板一致） */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** JSON 文件的二选一决议（path → 采用哪一侧；未显式选择则不下发） */
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})

  // 冲突切换 → 重置决议：文本取 ours，JSON 待选；激活第一个 tab
  useEffect(() => {
    if (!conflict) {
      setDrafts({})
      setDecisions({})
      setActivePath('')
      return
    }
    const nextDrafts: Record<string, string> = {}
    for (const f of conflict.files) {
      if (!isJsonSyncFile(f.path)) nextDrafts[f.path] = f.ours ?? ''
    }
    setDrafts(nextDrafts)
    setDecisions({})
    setActivePath(conflict.files[0]?.path ?? '')
  }, [conflict])

  useEffect(() => { activePathRef.current = activePath }, [activePath])

  const activeIsJson = isJsonSyncFile(activePath)
  const activeDraft = drafts[activePath] ?? ''

  // 上双 DiffEditor：ours vs theirs（只读，随激活 tab 重建）
  useEffect(() => {
    if (!conflict || !diffRef.current) return
    const file = conflict.files.find((f) => f.path === activePath)
    if (!file) return
    const language = isJsonSyncFile(file.path) ? JSON_LANGUAGE_ID : BEANCOUNT_LANGUAGE_ID
    const oursModel = monaco.editor.createModel(file.ours ?? '', language)
    const theirsModel = monaco.editor.createModel(file.theirs ?? '', language)
    const diff = monaco.editor.createDiffEditor(diffRef.current, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      fontSize: 13
    })
    diff.setModel({ original: oursModel, modified: theirsModel })
    return () => { diff.dispose(); oursModel.dispose(); theirsModel.dispose() }
  }, [conflict, activePath])

  // 下 merged 编辑器（一次创建；内容变化由 effect 推送）——无条件挂载，见组件注释
  useEffect(() => {
    const container = editorRef.current
    if (!container) return
    const editor = monaco.editor.create(container, {
      language: BEANCOUNT_LANGUAGE_ID,
      theme: monacoThemeForMode(mode),
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false
    })
    monacoRef.current = editor
    const sub = editor.onDidChangeModelContent(() => {
      const path = activePathRef.current
      if (!path) return
      setDrafts((prev) => (prev[path] === editor.getValue() ? prev : { ...prev, [path]: editor.getValue() }))
    })
    return () => { sub.dispose(); editor.dispose(); monacoRef.current = null }
    // 主题模式切换由下方 effect 热切换
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 主题模式切换 → 热切换 Monaco 主题（不重建编辑器实例）
  useEffect(() => {
    monaco.editor.setTheme(monacoThemeForMode(mode))
  }, [mode])

  // 激活 tab / 采用本地/采用远端 → 推 merged（值相同跳过，避免与 onDidChange 死循环）
  useEffect(() => {
    const editor = monacoRef.current
    if (!editor || activeIsJson) return
    if (editor.getValue() === activeDraft) return
    editor.setValue(activeDraft)
  }, [activeDraft, activeIsJson, activePath])

  /** 未做决议的 JSON 冲突文件（「完成合并」据此禁用） */
  const undecided = useMemo(
    () => (conflict?.files ?? []).filter((f) => isJsonSyncFile(f.path) && !decisions[f.path]).map((f) => f.path),
    [conflict, decisions]
  )

  const buildResolved = (files: SyncFileConflict[]): ResolveFileParam[] =>
    files.map((f) => {
      const path = f.path
      if (isJsonSyncFile(path)) {
        const side = decisions[path] ?? 'ours'
        return { path, content: side === 'theirs' ? f.theirs : f.ours }
      }
      return { path, content: drafts[path] ?? f.ours ?? '' }
    })

  const pick = (path: string, side: Decision): void => {
    const file = conflict?.files.find((f) => f.path === path)
    setDrafts((prev) => ({ ...prev, [path]: (side === 'theirs' ? file?.theirs : file?.ours) ?? '' }))
  }

  return (
    <div className="conflict-view">
      {conflict ? (
        <>
          <Alert
            type="warning"
            showIcon
            message={`同步冲突（${conflict.files.map((f) => syncFileLabel(f.path)).join('、')}）：本地与远端均修改了这些文件`}
            description="按文件逐个处理：账本在上方对比后于下方编辑合并结果；账户库 / Excel 模板无法自动并集，请在两个版本中选择一个。全部处理完后点「完成合并」校验并推送。"
          />
          <Tabs
            activeKey={activePath}
            onChange={setActivePath}
            items={conflict.files.map((f) => ({
              key: f.path,
              label: isJsonSyncFile(f.path) && !decisions[f.path] ? `${syncFileLabel(f.path)} ·` : syncFileLabel(f.path)
            }))}
          />
          <div className="conflict-buttons">
            <Space wrap>
              <Button onClick={() => (activeIsJson ? setDecisions((p) => ({ ...p, [activePath]: 'ours' })) : pick(activePath, 'ours'))}>
                采用本地
              </Button>
              <Button onClick={() => (activeIsJson ? setDecisions((p) => ({ ...p, [activePath]: 'theirs' })) : pick(activePath, 'theirs'))}>
                采用远端
              </Button>
              {activeIsJson ? (
                <Tag color={decisions[activePath] ? 'green' : 'orange'}>
                  {decisions[activePath] === 'ours' ? '已选：采用本地' : decisions[activePath] === 'theirs' ? '已选：采用远端' : '未选择（JSON 文件不做手工编辑）'}
                </Tag>
              ) : (
                <Tag color="blue">下方编辑合并结果</Tag>
              )}
              <Button
                type="primary"
                loading={syncing}
                disabled={undecided.length > 0}
                title={undecided.length > 0 ? `还有未处理的文件：${undecided.map(syncFileLabel).join('、')}` : undefined}
                onClick={() => void resolveConflict(buildResolved(conflict.files))}
              >
                完成合并
              </Button>
            </Space>
          </div>
          <div ref={diffRef} className="conflict-diff" />
        </>
      ) : (
        <Alert type="info" showIcon message="暂无冲突待处理" />
      )}
      {/* 无条件渲染（对齐 M5 editor-main 模式）：merged 编辑器挂载即创建，
          不受 conflict 早退影响——否则创建 effect 依赖 [] 时 bail 后永不重跑；
          JSON tab 用 display 隐藏而非卸载（卸载会让实例与手工编辑内容一起丢） */}
      <div ref={editorRef} className="conflict-merged" style={activeIsJson ? { display: 'none' } : undefined} />
    </div>
  )
}
