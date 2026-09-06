/**
 * 通用 Excel 流水导入面板（M10，录入页）。
 * 流程：选模板/新建 → 选文件 → 解析（新模板先列映射）→ 预览（新交易账户处理 + 勾选）→ 批量导入。
 * 策略 C：默认允许导入 + 未处理新账户强提示，模板严格模式阻塞导入。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
import { DeleteOutlined, ImportOutlined, SaveOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Input, message, Modal, Select, Space, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type {
  ExcelImportTemplate,
  ExcelParseResult,
  ExcelPreviewResult,
  ExcelPreviewRow,
  NewAccountResolution,
  TypeMappingResolution,
  AccountMappingConfig
} from '../../../../shared/ipc'
import { methodMapKey, typeMapKey } from '../../../../shared/import-keys'
import { useLedgerStore } from '../../stores/ledger'
import ExcelAccountMappingModal from './ExcelAccountMappingModal'
import ExcelColumnMappingModal from './ExcelColumnMappingModal'
import ExcelNewAccountSection from './ExcelNewAccountSection'
import ExcelNewTypeSection from './ExcelNewTypeSection'

interface Props {
  onImported: () => void
}

const NEW_TEMPLATE_ID = '__new__'

export default function ExcelImportPanel({ onImported }: Props) {
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const [templates, setTemplates] = useState<ExcelImportTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(NEW_TEMPLATE_ID)
  const [draft, setDraft] = useState<ExcelImportTemplate | null>(null)
  const [path, setPath] = useState('')
  const [parse, setParse] = useState<ExcelParseResult | null>(null)
  const [preview, setPreview] = useState<ExcelPreviewResult | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [resolutions, setResolutions] = useState<Record<string, NewAccountResolution>>({})
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [typeResolutions, setTypeResolutions] = useState<Record<string, TypeMappingResolution>>({})
  const [typeTargets, setTypeTargets] = useState<Record<string, string>>({})
  const [columnOpen, setColumnOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')

  useEffect(() => {
    void loadTemplates()
  }, [])

  const loadTemplates = async (): Promise<void> => {
    try {
      const r = await window.beanwise.getExcelTemplates()
      if (r.ok && r.templates) setTemplates(r.templates)
    } catch {
      /* 忽略，下次再试 */
    }
  }

  /** 有效模板 = 草稿 + 新交易账户归位（写回 sourceByMethod/cashAccountByMethod）+ 新交易类型映射（写回 expenseByType/incomeByType）。 */
  const effectiveTemplate = useMemo(() => {
    if (!draft) return null
    const sourceByMethod = { ...draft.accountMapping.sourceByMethod }
    const cashAccountByMethod = { ...draft.accountMapping.cashAccountByMethod }
    for (const [key, res] of Object.entries(resolutions)) {
      if ((res === 'existing' || res === 'new') && targets[key]?.trim()) {
        sourceByMethod[key] = targets[key].trim()
        cashAccountByMethod[key] = targets[key].trim()
      }
    }
    const expenseByType = { ...draft.accountMapping.expenseByType }
    const incomeByType = { ...draft.accountMapping.incomeByType }
    for (const [id, res] of Object.entries(typeResolutions)) {
      if (res !== 'mapped' || !typeTargets[id]?.trim()) continue
      const info = preview?.newTypes?.find((n) => n.id === id)
      if (!info) continue
      const mapKey = typeMapKey(info.key, info.method)
      if (info.kind === 'income') incomeByType[mapKey] = typeTargets[id].trim()
      else expenseByType[mapKey] = typeTargets[id].trim()
    }
    return { ...draft, accountMapping: { ...draft.accountMapping, sourceByMethod, cashAccountByMethod, expenseByType, incomeByType } }
  }, [draft, resolutions, targets, typeResolutions, typeTargets, preview])

  const excludedKeys = useMemo(
    () => new Set(Object.entries(resolutions).filter(([, r]) => r === 'exclude').map(([k]) => k)),
    [resolutions]
  )
  const unresolvedFallback = useMemo(
    () => (preview?.newAccounts ?? []).filter((n) => (resolutions[n.id] ?? 'fallback') === 'fallback'),
    [preview, resolutions]
  )
  const excludedTypeIds = useMemo(
    () => new Set(Object.entries(typeResolutions).filter(([, r]) => r === 'exclude').map(([id]) => id)),
    [typeResolutions]
  )
  const unresolvedTypeFallback = useMemo(
    () => (preview?.newTypes ?? []).filter((n) => (typeResolutions[n.id] ?? 'fallback') === 'fallback'),
    [preview, typeResolutions]
  )

  const handleTemplateChange = (id: string) => {
    setSelectedTemplateId(id)
    if (id === NEW_TEMPLATE_ID) {
      setDraft(null)
      setPreview(null)
      setPreviewOpen(false)
    } else {
      setDraft(templates.find((t) => t.id === id) ?? null)
      setPreview(null)
      setPreviewOpen(false)
    }
  }

  const doParse = async (filePath: string, openColumnModal: boolean): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.beanwise.parseExcelFile({ path: filePath })
      if (!r.ok || !r.columns) {
        const msg = r.message ?? '解析失败'
        setError(msg)
        message.error(msg)
        return
      }
      setParse(r)
      setPreview(null)
      setPreviewOpen(false)
      if (openColumnModal) setColumnOpen(true)
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, '')
      setError(msg)
      message.error(msg)
    } finally {
      setLoading(false)
    }
  }

  const doPreview = async (filePath: string, template: ExcelImportTemplate): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.beanwise.previewExcelImport({ path: filePath, template })
      if (!r.ok || !r.rows) {
        const msg = r.message ?? '解析失败'
        setError(msg)
        message.error(msg)
        return
      }
      setPreview(r)
      setResolutions(Object.fromEntries((r.newAccounts ?? []).map((n) => [n.id, n.resolution])))
      setTargets(Object.fromEntries((r.newAccounts ?? []).map((n) => [n.id, n.suggestedAccount])))
      setTypeResolutions(Object.fromEntries((r.newTypes ?? []).map((n) => [n.id, n.resolution])))
      setTypeTargets(Object.fromEntries((r.newTypes ?? []).map((n) => [n.id, n.suggestedAccount])))
      setSelected(r.rows.filter((row) => row.dupState !== 'exact' && row.dupState !== 'suspect').map((row) => row.rowId))
      setPreviewOpen(true)
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, '')
      setError(msg)
      message.error(msg)
    } finally {
      setLoading(false)
    }
  }

  const handleChoose = async () => {
    setError(null)
    setLoading(true)
    try {
      const r = await window.beanwise.chooseExcelFile()
      if (r.canceled || !r.ok || !r.path) return
      setPath(r.path)
      await doParse(r.path, selectedTemplateId === NEW_TEMPLATE_ID)
      if (selectedTemplateId !== NEW_TEMPLATE_ID && draft) {
        await doPreview(r.path, draft)
      }
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, '')
      setError(msg)
      message.error(msg)
    } finally {
      setLoading(false)
    }
  }

  const handleColumnSave = async (template: ExcelImportTemplate) => {
    setColumnOpen(false)
    try {
      const r = await window.beanwise.saveExcelTemplate(template)
      if (!r.ok || !r.template) {
        message.error(r.message ?? '保存失败')
        return
      }
      setDraft(r.template)
      setSelectedTemplateId(r.template.id)
      await loadTemplates()
      message.success('模板已保存')
      if (path) await doPreview(path, r.template)
    } catch (err) {
      message.error(String(err))
    }
  }

  const handleAccountSave = async (accountMapping: AccountMappingConfig) => {
    setAccountOpen(false)
    if (!draft) {
      message.warning('请先新建/选择模板')
      return
    }
    const next = { ...draft, accountMapping }
    setDraft(next)
    if (next.id) {
      try {
        const r = await window.beanwise.saveExcelTemplate(next)
        if (r.ok && r.template) {
          setDraft(r.template)
          await loadTemplates()
          message.success('账户映射已保存')
        } else {
          message.error(r.message ?? '保存失败')
        }
      } catch (err) {
        message.error(String(err))
      }
    } else {
      message.info('账户映射已更新，保存模板后生效')
    }
  }

  const handleSaveTemplate = async () => {
    if (!effectiveTemplate) return
    try {
      const r = await window.beanwise.saveExcelTemplate(effectiveTemplate)
      if (r.ok && r.template) {
        setDraft(r.template)
        setSelectedTemplateId(r.template.id)
        await loadTemplates()
        message.success('模板已保存（含新账户归位与新类型映射）')
      } else {
        message.error(r.message ?? '保存失败')
      }
    } catch (err) {
      message.error(String(err))
    }
  }

  const handleDeleteTemplate = () => {
    if (!draft || !draft.id) return
    Modal.confirm({
      title: '删除导入模板',
      content: `确定要删除模板「${draft.name}」吗？删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.beanwise.deleteExcelTemplate(draft.id)
          setSelectedTemplateId(NEW_TEMPLATE_ID)
          setDraft(null)
          setPreview(null)
          setPreviewOpen(false)
          await loadTemplates()
          message.success('模板已删除')
        } catch (err) {
          message.error(String(err))
        }
      }
    })
  }

  const closePreview = () => {
    setPreviewOpen(false)
    setPreview(null)
    setSelected([])
    setKeyword('')
    setError(null)
  }

  const handleImport = async () => {
    if (!effectiveTemplate || selected.length === 0) return
    if (effectiveTemplate.strictNewAccounts && (unresolvedFallback.length > 0 || unresolvedTypeFallback.length > 0)) {
      message.warning('严格模式下请先处理全部新交易账户与新交易类型')
      return
    }
    const rowIdToKey = new Map((preview?.rows ?? []).map((r) => [r.rowId, methodMapKey(r.paymentMethod, r.transactionType)]))
    const rowIdToTypeId = new Map((preview?.rows ?? []).map((r) => [r.rowId, `${r.kind}:${typeMapKey(r.transactionType, r.paymentMethod)}`]))
    const rowIds = selected.filter(
      (id) => !excludedKeys.has(rowIdToKey.get(id) ?? '') && !excludedTypeIds.has(rowIdToTypeId.get(id) ?? '')
    )
    if (rowIds.length === 0) {
      message.warning('排除后没有可导入的行')
      return
    }
    setImporting(true)
    setError(null)
    try {
      const r = await window.beanwise.importExcel({ path, template: effectiveTemplate, rowIds })
      if (r.ok) {
        message.success(`已导入 ${r.imported ?? 0} 笔流水${r.skipped ? `，跳过 ${r.skipped} 笔` : ''}`)
        await useLedgerStore.getState().refresh()
        onImported()
        closePreview()
      } else {
        setError(r.message ?? '导入失败')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setImporting(false)
    }
  }

  const totalAmount = selected.reduce((sum, id) => {
    const row = preview?.rows?.find((r) => r.rowId === id)
    return sum + (row ? Number(row.amount) : 0)
  }, 0)

  /** 预览行搜索：按交易类型 / 支付方式（映射键）过滤 */
  const visibleRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const rows = preview?.rows ?? []
    if (!kw) return rows
    return rows.filter(
      (r) => r.transactionType.toLowerCase().includes(kw) || r.paymentMethod.toLowerCase().includes(kw)
    )
  }, [preview, keyword])

  return (
    <>
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={
          <Space size={8}>
            <ImportOutlined />
            <span>Excel 流水导入</span>
            <Tag color="green">任意 xlsx / xls / csv / pdf</Tag>
          </Space>
        }
        extra={
          <Button
            icon={<SettingOutlined />}
            onClick={() => {
              if (!draft) {
                message.warning('请先选择模板或新建模板')
                return
              }
              setAccountOpen(true)
            }}
          >
            账户映射
          </Button>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Space size={12} wrap>
            <span>导入模板：</span>
            <Select
              style={{ width: 300 }}
              value={selectedTemplateId}
              onChange={handleTemplateChange}
              options={[{ value: NEW_TEMPLATE_ID, label: '新建模板…' }, ...templates.map((t) => ({ value: t.id, label: t.name }))]}
            />
            {selectedTemplateId !== NEW_TEMPLATE_ID && draft ? (
              <Button size="small" icon={<DeleteOutlined />} onClick={() => void handleDeleteTemplate()}>
                删除模板
              </Button>
            ) : null}
          </Space>
          <Typography.Text type="secondary">
            支持任意 xlsx / xls / csv / pdf 流水（银行卡、支付宝、对账单等）：先配置列映射与账户映射，预览确认后批量导入；
            新银行卡/充值渠道等未映射支付方式会在预览中提示处理。
          </Typography.Text>
          <Space>
            <Button type="primary" icon={<ImportOutlined />} onClick={() => void handleChoose()} loading={loading}>
              选择 Excel 并导入
            </Button>
            <Button
              onClick={() => {
                if (!parse) {
                  message.info('请先选择文件解析')
                  return
                }
                setColumnOpen(true)
              }}
              disabled={!parse}
            >
              列映射
            </Button>
          </Space>
        </Space>
      </Card>

      <Modal
        title="Excel 流水导入预览"
        open={previewOpen}
        onCancel={closePreview}
        width={1440}
        destroyOnClose
        footer={[
          <Button key="cancel" onClick={closePreview}>取消</Button>,
          <Button key="save" icon={<SaveOutlined />} onClick={() => void handleSaveTemplate()} disabled={!effectiveTemplate}>
            保存模板
          </Button>,
          <Button
            key="import"
            type="primary"
            loading={importing}
            disabled={!preview || selected.length === 0 || (effectiveTemplate?.strictNewAccounts === true && (unresolvedFallback.length > 0 || unresolvedTypeFallback.length > 0))}
            onClick={() => void handleImport()}
          >
            导入选中的 {selected.length} 笔
          </Button>
        ]}
      >
        {error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} /> : null}
        {preview ? (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Alert
              type="info"
              showIcon
              message={`文件：${path}`}
              description={
                preview.totals
                  ? `共 ${preview.totals.total} 行：支出 ${preview.totals.expense}、收入 ${preview.totals.income}、` +
                    `提现/充值等中性 ${preview.totals.neutral}；已导入 ${preview.totals.alreadyImported} 行、` +
                    `疑似重复 ${preview.totals.suspect} 行默认跳过（可手动勾选保留），需确认 ${preview.totals.confirm} 行请人工核对；` +
                    `未映射交易类型 ${preview.newTypes?.length ?? 0} 个见下方区块。`
                  : ''
              }
            />
            {preview.newAccounts && preview.newAccounts.length > 0 ? (
              <ExcelNewAccountSection
                items={preview.newAccounts}
                accountOptions={accountOptions}
                resolutions={resolutions}
                targets={targets}
                strict={effectiveTemplate?.strictNewAccounts === true}
                onChange={(id, res, target) => {
                  setResolutions((prev) => ({ ...prev, [id]: res }))
                  if (target !== undefined) setTargets((prev) => ({ ...prev, [id]: target }))
                }}
              />
            ) : null}
            {preview.newTypes && preview.newTypes.length > 0 ? (
              <ExcelNewTypeSection
                items={preview.newTypes}
                accountOptions={accountOptions}
                resolutions={typeResolutions}
                targets={typeTargets}
                strict={effectiveTemplate?.strictNewAccounts === true}
                onChange={(id, res, target) => {
                  setTypeResolutions((prev) => ({ ...prev, [id]: res }))
                  if (target !== undefined) setTypeTargets((prev) => ({ ...prev, [id]: target }))
                }}
              />
            ) : null}
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索交易类型 / 支付方式（映射键）"
              style={{ width: 300, marginBottom: 4 }}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <ProTable<ExcelPreviewRow>
              size="small"
              rowKey="rowId"
              dataSource={visibleRows}
              scroll={{ x: 1250, y: 360 }}
              rowSelection={{
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys as string[])
              }}
              pagination={{
                defaultPageSize: 50,
                pageSizeOptions: [20, 50, 100, 200],
                showSizeChanger: true,
                showTotal: (total) => `共 ${total} 行`
              }}
              search={false}
              options={false}
              columns={columns}
            />
            <Typography.Text type="secondary">合计选中金额：{totalAmount.toFixed(2)} 元</Typography.Text>
          </Space>
        ) : null}
      </Modal>

      <ExcelColumnMappingModal
        open={columnOpen}
        sheets={parse?.sheets ?? []}
        columns={parse?.columns ?? []}
        headerRow={parse?.headerRow}
        suggested={parse?.suggestedMapping ?? null}
        existing={draft}
        onSave={(t) => void handleColumnSave(t)}
        onClose={() => setColumnOpen(false)}
      />

      <ExcelAccountMappingModal
        open={accountOpen}
        accountMapping={draft?.accountMapping ?? null}
        accountOptions={accountOptions}
        onSave={(m) => void handleAccountSave(m)}
        onClose={() => setAccountOpen(false)}
      />
    </>
  )
}

const columns: ProColumns<ExcelPreviewRow>[] = [
  { title: '日期', dataIndex: 'date', width: 104 },
  { title: '时间', dataIndex: 'time', width: 76 },
  { title: '交易类型', dataIndex: 'transactionType', width: 110, ellipsis: true },
  { title: '交易对方', dataIndex: 'counterparty', ellipsis: true },
  { title: '商品/摘要', dataIndex: 'product', ellipsis: true },
  { title: '金额', dataIndex: 'amount', width: 90, align: 'right' },
  { title: '支付方式', dataIndex: 'paymentMethod', width: 150, ellipsis: true },
  {
    title: '类别',
    dataIndex: 'kind',
    width: 96,
    render: (_dom: unknown, row: ExcelPreviewRow) => (
      <Tag color={row.kind === 'expense' ? 'red' : row.kind === 'income' ? 'green' : 'blue'}>
        {row.kind === 'expense' ? '支出' : row.kind === 'income' ? '收入/退款' : '提现/充值'}
      </Tag>
    )
  },
  {
    title: '主账户',
    dataIndex: 'expenseAccount',
    width: 180,
    render: (_dom: unknown, row: ExcelPreviewRow) => <Typography.Text style={{ fontSize: 12 }}>{row.expenseAccount}</Typography.Text>
  },
  {
    title: '来源账户',
    dataIndex: 'sourceAccount',
    width: 180,
    render: (_dom: unknown, row: ExcelPreviewRow) => <Typography.Text style={{ fontSize: 12 }}>{row.sourceAccount}</Typography.Text>
  },
  {
    title: '去重状态',
    dataIndex: 'dupState',
    width: 110,
    render: (_dom: unknown, row: ExcelPreviewRow) =>
      row.dupState === 'exact' ? (
        <Tag color="default">已导入</Tag>
      ) : row.dupState === 'suspect' ? (
        <Tag color="orange">疑似重复</Tag>
      ) : row.dupState === 'confirm' ? (
        <Tag color="volcano">需确认</Tag>
      ) : (
        <Tag color="success">待导入</Tag>
      )
  }
]
