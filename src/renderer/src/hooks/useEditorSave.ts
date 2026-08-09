import { useCallback } from 'react'
import { useLedgerStore } from '../stores/ledger'

/**
 * M5：编辑器保存流程 UI 入口。状态机逻辑在 ledgerStore actions
 * （save/forceSave/reload 可 node 单测），本 hook 仅做选择器 + 动作绑定。
 */
export function useEditorSave() {
  const content = useLedgerStore((s) => s.editorContent)
  const original = useLedgerStore((s) => s.editorOriginal)
  const saving = useLedgerStore((s) => s.editorSaving)
  const conflict = useLedgerStore((s) => s.editorConflict)
  const dirty = content !== null && content !== original

  const save = useCallback(() => { void useLedgerStore.getState().saveEditorFile() }, [])
  const forceSave = useCallback(() => { void useLedgerStore.getState().forceSaveEditorFile() }, [])
  const reload = useCallback(() => { void useLedgerStore.getState().reloadEditorFile() }, [])
  const continueEditing = useCallback(() => { useLedgerStore.getState().continueEdit() }, [])

  return { dirty, saving, conflict, save, forceSave, reload, continueEditing }
}
