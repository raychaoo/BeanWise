import { ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { Alert, Button, Empty, Space, Tag } from 'antd'
import * as monaco from 'monaco-editor'
import { useEffect, useRef } from 'react'
import { useEditorSave } from '../../hooks/useEditorSave'
import { BEANCOUNT_LANGUAGE_ID, monacoThemeForMode, registerBeancountLanguage } from '../../monaco/beancount-language'
import { useLedgerStore } from '../../stores/ledger'
import { useThemeContext } from '../../theme/ThemeProvider'

registerBeancountLanguage(monaco) // 模块级注册一次（幂等）

/**
 * M5：账本编辑器视图。打开 → beancount 高亮 → 编辑 → 保存（tmp 校验 + rename 原子替换）
 * → 校验提示；保存时外部修改冲突 → DiffEditor（磁盘 vs 本地）三动作决策。
 * 视图由 App.tsx 保活（display 切换），组件常驻不销毁。
 */
export default function EditorView() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const diffRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const loaded = useLedgerStore((s) => s.editorLoaded)
  const missing = useLedgerStore((s) => s.editorMissing)
  const content = useLedgerStore((s) => s.editorContent)
  const { dirty, saving, conflict, save, forceSave, reload, continueEditing } = useEditorSave()
  const { mode } = useThemeContext()

  // 保存动作经 ref 引用：create effect 依赖保持空数组（避免 dirty 变化重建编辑器）
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save })

  // 路由化（批次 A）：重挂载时若已有已加载基线则跳过重读——保留未保存内容与冲突检测基线
  //（旧 display:none 保活语义等价；「重新加载」按钮 / 工作目录切换不受影响）
  useEffect(() => {
    if (!useLedgerStore.getState().editorLoaded) void useLedgerStore.getState().loadEditorFile()
  }, [])

  // 创建主编辑器（一次）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const editor = monaco.editor.create(container, {
      language: BEANCOUNT_LANGUAGE_ID,
      theme: monacoThemeForMode(mode),
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false
    })
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveRef.current() })
    const sub = editor.onDidChangeModelContent(() => {
      useLedgerStore.getState().setEditorContent(editor.getValue())
    })
    return () => { sub.dispose(); editor.dispose(); editorRef.current = null }
    // 仅在首次挂载时创建；后续模式变化由下方 effect 热切换主题
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 主题模式切换 → 热切换 Monaco 主题（不重建编辑器实例）
  useEffect(() => {
    monaco.editor.setTheme(monacoThemeForMode(mode))
  }, [mode])

  // 外部装载/重载：基线或内容变化后推送（值相同跳过，避免与 onDidChange 死循环）
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || content === null) return
    if (editor.getValue() === content) return
    editor.setValue(content)
  }, [content])

  // 冲突面板 DiffEditor（monaco 直用双 model 组合，为 M6 三路合并铺路）
  useEffect(() => {
    if (!conflict || !diffRef.current) return
    const originalModel = monaco.editor.createModel(conflict.diskContent, BEANCOUNT_LANGUAGE_ID)
    const modifiedModel = monaco.editor.createModel(content ?? '', BEANCOUNT_LANGUAGE_ID)
    const diff = monaco.editor.createDiffEditor(diffRef.current, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      fontSize: 13
    })
    diff.setModel({ original: originalModel, modified: modifiedModel })
    return () => { diff.dispose(); originalModel.dispose(); modifiedModel.dispose() }
  }, [conflict, content])

  return (
    <div className="editor-view">
      <div className="editor-toolbar">
        <Space>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => save()}>
            保存
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => reload()}>重载</Button>
          <Tag color={dirty ? 'warning' : 'success'}>{dirty ? '未保存' : '已保存'}</Tag>
        </Space>
      </div>
      {conflict ? (
        <div className="editor-conflict">
          <Alert
            type="warning"
            showIcon
            message="文件已被外部修改（录入视图追加或外部编辑器）"
            description="左侧为磁盘最新内容，右侧为当前编辑内容。选择：重新加载（放弃本地修改）或强制保存（覆盖外部修改）。"
            action={
              <Space>
                <Button size="small" onClick={continueEditing}>继续编辑</Button>
                <Button size="small" onClick={() => reload()}>重新加载</Button>
                <Button size="small" type="primary" danger loading={saving} onClick={() => forceSave()}>
                  强制保存
                </Button>
              </Space>
            }
          />
          <div ref={diffRef} className="editor-diff" />
        </div>
      ) : null}
      <div ref={containerRef} className="editor-main" />
      {loaded && missing ? (
        <div className="editor-empty">
          <Empty description="账本文件不存在，请先在录入视图录一笔创建" />
        </div>
      ) : null}
    </div>
  )
}
