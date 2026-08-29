import { AuditOutlined } from '@ant-design/icons'
import { Result } from 'antd'

/** 对账占位页（批次 D 重写本文件内容，App.tsx 路由不动） */
export default function ReconcilePage() {
  return <Result icon={<AuditOutlined />} title="对账" subTitle="批次 D 落地" />
}
