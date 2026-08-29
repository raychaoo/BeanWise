import { SettingOutlined } from '@ant-design/icons'
import { Card, Result, Space, Typography } from 'antd'

const SECTIONS = ['账本管理', '同步', 'AI', '索引', '关于'] as const

/** 设置占位页（批次 D 重写本文件内容）：五个分区 Card 骨架，各域状态卡/危险操作的迁入点 */
export default function SettingsPage() {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Result icon={<SettingOutlined />} title="设置" subTitle="批次 D 落地" />
      {SECTIONS.map((section) => (
        <Card key={section} title={section} size="small">
          <Typography.Text type="secondary">批次 D 落地</Typography.Text>
        </Card>
      ))}
    </Space>
  )
}
