/**
 * M7：AI 辅助录入面板（录入视图顶部，Collapse 收折）。单次生成 + 草稿确认（设计 spec §4）：
 * 输入自然语言 → ai:parse → 草稿列表（只读摘要）→ 每笔「填入表单」→ 用户走 ProForm
 * 现有提交流程落盘（写路径唯一，M7 不加第二条写路径）。未配置 Key → 引导去 AI 设置。
 */
import { RobotOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Collapse, Input, Space, Typography } from 'antd'
import { useState } from 'react'
import type { AddEntryParams } from '../../../shared/ipc'
import { useAiStore } from '../stores/ai'

interface Props {
  /** 未配置引导「去设置」 → 打开 AI 设置 Modal */
  onOpenSettings: () => void
  /** 草稿「填入表单」 → 回填 ProForm（写路径仍走表单提交） */
  onFillForm: (draft: AddEntryParams) => void
}

/** 生成按钮可用性（纯函数，node 单测）：非空文本 */
export function canGenerate(text: string): boolean {
  return text.trim().length > 0
}

/** 草稿卡片摘要（纯函数，node 单测） */
export function formatDraftSummary(draft: AddEntryParams): string {
  const head = [draft.date, draft.flag ?? '*', draft.payee ?? '', draft.narration ?? ''].filter(Boolean).join(' ')
  const postings = draft.postings.map((p) => `${p.account} ${p.number} ${p.currency}`).join('；')
  return `${head}\n${postings}`
}

export default function AiEntryPanel({ onOpenSettings, onFillForm }: Props) {
  const status = useAiStore((s) => s.status)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [drafts, setDrafts] = useState<AddEntryParams[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filled, setFilled] = useState<boolean[]>([])
  const configured = status?.configured ?? false

  const generate = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.beanwise.parseAiEntry(text)
      if (!r.ok) {
        setError(r.error ?? '生成失败')
        setDrafts(null)
      } else {
        setDrafts(r.drafts ?? [])
        setFilled((r.drafts ?? []).map(() => false))
      }
    } catch (err) {
      setError(String(err))
      setDrafts(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Collapse
      style={{ marginBottom: 16 }}
      items={[{
        key: 'ai',
        label: 'AI 辅助录入',
        children: (
          <Space direction="vertical" style={{ width: '100%' }}>
            {!configured ? (
              <Alert
                type="info"
                message="尚未配置 DeepSeek API Key"
                description="配置后即可用自然语言生成记账草稿。"
                action={<Button size="small" onClick={onOpenSettings}>去设置</Button>}
              />
            ) : null}
            <Input.TextArea
              placeholder="例如：昨天午饭花了 25.5 元，用银行卡支付"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={2000}
              rows={2}
              disabled={loading}
            />
            <Button
              type="primary"
              icon={<RobotOutlined />}
              loading={loading}
              disabled={!canGenerate(text)}
              onClick={() => void generate()}
              style={{ alignSelf: 'flex-end' }}
            >
              生成草稿
            </Button>
            {error ? (
              <Alert
                type="error"
                message={error}
                action={<Button size="small" onClick={() => void generate()}>重试</Button>}
              />
            ) : null}
            {drafts ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                {drafts.map((draft, i) => (
                  <Card
                    key={i}
                    size="small"
                    title={`草稿 ${i + 1}`}
                    extra={
                      <Button
                        size="small"
                        disabled={filled[i]}
                        onClick={() => {
                          setFilled((f) => f.map((v, j) => (j === i ? true : v)))
                          onFillForm(draft)
                        }}
                      >
                        {filled[i] ? '已填入' : '填入表单'}
                      </Button>
                    }
                  >
                    <Typography.Text style={{ whiteSpace: 'pre-line' }}>
                      {formatDraftSummary(draft)}
                    </Typography.Text>
                  </Card>
                ))}
              </Space>
            ) : null}
          </Space>
        )
      }]} />
  )
}
