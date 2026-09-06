import { Alert, Button, Space } from 'antd'
import * as monaco from 'monaco-editor'
import { useEffect, useRef, useState } from 'react'
import { BEANCOUNT_LANGUAGE_ID, monacoThemeForMode, registerBeancountLanguage } from '../../monaco/beancount-language'
import { useSyncStore } from '../../stores/sync'
import { useThemeContext } from '../../theme/ThemeProvider'

registerBeancountLanguage(monaco) // 模块级注册一次（幂等，M5）

/**
 * M6：三路合并视图（ADR 9 自研，M5 DiffEditor 双 model 模式复用）。
 * 上双 DiffEditor（ours / theirs 只读对比）+ 下 merged 可编辑 Monaco（beancount 高亮）+
 * 三按钮：采用本地（merged←ours）/ 采用远端（merged←theirs）/ 完成合并（resolve）。
 * 合并结果校验失败 → 错误提示，merged 保留供修改（不丢内容）。
 */
export default function ConflictView() {
  const conflict = useSyncStore((s) => s.conflict)
  const syncing = useSyncStore((s) => s.syncing)
  const resolveConflict = useSyncStore((s) => s.resolveConflict)
  const { mode } = useThemeContext()

  const diffRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // merged 内容组件态（视图保活 display 切换不销毁实例，内容保留）
  const [merged, setMerged] = useState('')

  // 冲突切换时重置 merged = ours（本地优先，视觉与 M5 冲突面板一致）
  useEffect(() => {
    if (conflict) setMerged(conflict.ours)
  }, [conflict])

  // 上双 DiffEditor：ours vs theirs（只读）
  useEffect(() => {
    if (!conflict || !diffRef.current) return
    const oursModel = monaco.editor.createModel(conflict.ours, BEANCOUNT_LANGUAGE_ID)
    const theirsModel = monaco.editor.createModel(conflict.theirs, BEANCOUNT_LANGUAGE_ID)
    const diff = monaco.editor.createDiffEditor(diffRef.current, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      fontSize: 13
    })
    diff.setModel({ original: oursModel, modified: theirsModel })
    return () => { diff.dispose(); oursModel.dispose(); theirsModel.dispose() }
  }, [conflict])

  // 下 merged 编辑器（一次创建；内容变化由 effect 推送）
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
    const sub = editor.onDidChangeModelContent(() => setMerged(editor.getValue()))
    return () => { sub.dispose(); editor.dispose(); monacoRef.current = null }
    // 主题模式切换由下方 effect 热切换
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 主题模式切换 → 热切换 Monaco 主题（不重建编辑器实例）
  useEffect(() => {
    monaco.editor.setTheme(monacoThemeForMode(mode))
  }, [mode])

  // 采用本地/采用远端 → 推 merged（值相同跳过，避免与 onDidChange 死循环）
  useEffect(() => {
    const editor = monacoRef.current
    if (!editor) return
    if (editor.getValue() === merged) return
    editor.setValue(merged)
  }, [merged])

  return (
    <div className="conflict-view">
      {conflict ? (
        <>
          <Alert
            type="warning"
            showIcon
            message="同步冲突：本地与远端均修改了账本"
            description="上方左侧为本地内容、右侧为远端内容；在下方案例区编辑合并结果，然后「完成合并」校验并推送。"
          />
          <div className="conflict-buttons">
            <Space>
              <Button onClick={() => setMerged(conflict.ours)}>采用本地</Button>
              <Button onClick={() => setMerged(conflict.theirs)}>采用远端</Button>
              <Button type="primary" loading={syncing} onClick={() => void resolveConflict(merged)}>
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
          不受 conflict 早退影响——否则创建 effect 依赖 [] 时 bail 后永不重跑 */}
      <div ref={editorRef} className="conflict-merged" />
    </div>
  )
}
