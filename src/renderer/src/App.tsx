import { useEffect, useState } from 'react'
import type { LedgerEntryRow, LedgerStatus } from '../../shared/ipc'

// M3 验收面板：只读索引状态展示（非业务 UI，M4 起由正式界面取代）。
// 不引入 antd（M4 依赖），保持 M3 依赖最小。
export default function App() {
  const [status, setStatus] = useState<LedgerStatus | null>(null)
  const [entries, setEntries] = useState<LedgerEntryRow[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = async () => {
    const [s, r] = await Promise.all([
      window.beanwise.getLedgerStatus(),
      window.beanwise.listLedgerEntries({ limit: 200 })
    ])
    setStatus(s)
    setEntries(r.entries)
  }

  useEffect(() => {
    void load().catch((err: unknown) => setMessage(String(err)))
  }, [])

  const refresh = async () => {
    setRefreshing(true)
    setMessage(null)
    try {
      const result = await window.beanwise.refreshLedgerIndex()
      if (result.status === 'error') setMessage(result.message ?? '索引重建失败')
      await load()
    } catch (err) {
      setMessage(String(err))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <main className="app">
      <h1>{window.beanwise.appName}</h1>
      <section id="ledger-status">
        <h2>索引状态</h2>
        {status ? (
          <ul className="status-list">
            <li>路径：<code id="ledger-path">{status.path}</code></li>
            <li>标题：{status.title ?? '—'}</li>
            <li>货币：{status.operatingCurrency.join(', ') || '—'}</li>
            <li>条目数：<span id="entry-count">{status.entryCount}</span></li>
            <li>错误数：<span id="error-count">{status.errorCount}</span></li>
            <li>状态：<span id="index-status">{status.status}</span></li>
            {status.lastError && <li className="error-text">错误：{status.lastError}</li>}
            <li>更新时间：{status.updatedAt ? new Date(status.updatedAt).toLocaleString() : '—'}</li>
          </ul>
        ) : (
          <p>尚未索引</p>
        )}
        {message && <p className="error-text" id="refresh-message">{message}</p>}
        <button id="refresh-btn" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? '刷新中…' : '刷新索引'}
        </button>
      </section>
      <section id="ledger-entries">
        <h2>条目（{entries.length}）</h2>
        <ul className="entry-list">
          {entries.map((entry) => (
            <li key={entry.id} data-type={entry.type}>
              <span className="entry-date">{entry.date}</span>
              <span className="entry-type">{entry.type}</span>
              {entry.payee && <span className="entry-payee">{entry.payee}</span>}
              {entry.narration && <span className="entry-narration">{entry.narration}</span>}
              {entry.account && <span className="entry-account">{entry.account}</span>}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
