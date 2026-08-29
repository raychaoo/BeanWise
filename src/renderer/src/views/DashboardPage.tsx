import { DashboardOutlined } from '@ant-design/icons'
import { Result } from 'antd'

/** 总览占位页（批次 D 重写本文件内容，App.tsx 路由不动） */
export default function DashboardPage() {
  return <Result icon={<DashboardOutlined />} title="总览" subTitle="批次 D 落地" />
}
