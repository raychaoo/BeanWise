import { Input, Modal, theme } from 'antd'
import type { InputRef } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import { basenamePath } from '../utils/path'

interface QuickSwitchModalProps {
  open: boolean
  onClose(): void
  /** 最近工作目录（最新在前，调用方负责排除当前目录） */
  recents: string[]
  /** 选中即切换（复用 LedgerSwitcher 导出的 switchWorkspace：dirty 确认 + open + 整页 reload） */
  onPick(path: string): void
}

/**
 * Ctrl+K 账本快捷切换弹层：Input 过滤（basenamePath 包含匹配，不区分大小写）
 * + ↑↓ 选择 / Enter 确认 / 点击直接切换。零新依赖。
 */
export default function QuickSwitchModal({ open, onClose, recents, onPick }: QuickSwitchModalProps) {
  const [keyword, setKeyword] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<InputRef>(null)
  const { token } = theme.useToken()

  // 每次打开重置过滤词与选中项
  useEffect(() => {
    if (open) {
      setKeyword('')
      setActive(0)
    }
  }, [open])

  // rc-dialog 打开动画结束后会把焦点移到对话框容器，需在 afterOpenChange 再聚焦过滤输入框
  const afterOpenChange = (visible: boolean): void => {
    if (visible) inputRef.current?.focus()
  }

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return recents
    return recents.filter((p) => basenamePath(p).toLowerCase().includes(kw))
  }, [keyword, recents])

  const pick = (path: string): void => {
    onClose()
    onPick(path)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const path = filtered[active]
      if (path) pick(path)
    }
  }

  return (
    <Modal title="切换账本" open={open} onCancel={onClose} footer={null} width={420} afterOpenChange={afterOpenChange}>
      <Input
        ref={inputRef}
        placeholder="输入目录名过滤"
        value={keyword}
        onChange={(e) => {
          setKeyword(e.target.value)
          setActive(0)
        }}
        onKeyDown={handleKeyDown}
      />
      <div style={{ marginTop: 12, maxHeight: 320, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '12px 4px', color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
            无匹配的最近账本
          </div>
        ) : (
          filtered.map((p, i) => (
            <div
              key={p}
              title={p}
              onClick={() => pick(p)}
              onMouseEnter={() => setActive(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '7px 10px',
                borderRadius: token.borderRadius,
                cursor: 'pointer',
                background: i === active ? token.controlItemBgHover : 'transparent'
              }}
            >
              <span style={{ whiteSpace: 'nowrap' }}>{basenamePath(p)}</span>
              <span
                style={{
                  color: token.colorTextTertiary,
                  fontSize: token.fontSizeSM,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {p}
              </span>
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}
