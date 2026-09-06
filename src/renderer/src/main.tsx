// 必须最先导入：antd v5 + React 19 静态方法补丁（先于一切 antd import，否则 antd 挂载报错）
import '@ant-design/v5-patch-for-react-19'
// M5：Monaco worker 接线 + CSS（必须在任何 monaco 编辑器创建前、App import 之前）
import './monaco/setup'
import 'dayjs/locale/zh-cn'
import React from 'react'
import ReactDOM from 'react-dom/client'
import zhCN from 'antd/locale/zh_CN'
import { createGlobalStyle } from 'antd-style'
import dayjs from 'dayjs'
import App from './App'
import { ThemeProvider } from './theme/ThemeProvider'
import './styles/tokens.less'
import './styles/base.less'
import './styles/layout.less'

// ProLayout actions 区溢出修复：actions 容器高度大于 header 时，hover 背景会溢出 header 区域
// 约束 actions 行高度并 clip hover 背景
const HeaderActionsFix = createGlobalStyle`
  .ant-pro-global-header-header-actions-item {
    height: 32px !important;
    overflow: hidden;
  }
  .ant-pro-global-header-header-actions-item > * {
    height: 32px;
    line-height: 32px;
  }
`

dayjs.locale('zh-cn')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider locale={zhCN}>
      <HeaderActionsFix />
      <App />
    </ThemeProvider>
  </React.StrictMode>
)
