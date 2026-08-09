// 必须最先导入：antd v5 + React 19 静态方法补丁（先于一切 antd import，否则 antd 挂载报错）
import '@ant-design/v5-patch-for-react-19'
// M5：Monaco worker 接线 + CSS（必须在任何 monaco 编辑器创建前、App import 之前）
import './monaco/setup'
import 'dayjs/locale/zh-cn'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import App from './App'
import './styles.css'

dayjs.locale('zh-cn')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
