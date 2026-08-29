# BeanWise UI 优化方案（ui-v4）

> 依据 `ui-plan.md` 需求书 + ui-v4 分支实际代码编写。所有「现状问题」均来自真实代码（文件:行号可查），无 `[假设]` 项；涉及超出 UI 层的能力缺口已单独标注，交由你决策。
> 视角：能查看代码库（分支 `ui-v4`，当前 HEAD `f4c9f78`）。

---

## 〇、现状问题总览（基于 ui-v4 实际代码）

| # | 问题 | 出处 |
|---|---|---|
| 1 | 无路由：`useState` 切 5 个视图，entry/entries/editor/conflict 用 `display:none` 常驻挂载（5 个视图同时活在 DOM），无 URL、无默认路由、无 404 | `App.tsx:29,164-174` |
| 2 | 整页滚动：`Content` 无独立滚动容器，内容长时 Header/Sider 被滚走；编辑器视图靠 `calc(100vh - 112px)` 魔法数撑高 | `App.tsx:106,163,168` |
| 3 | Header 堆 8 个元素：appName（与 Sider logo 重复）、AI Tag、AI 设置、更新、索引 Tag、同步条（分支/上次同步/拉取/设置），拥挤且无层级 | `App.tsx:141-162`、`SyncStatusBar.tsx` |
| 4 | Sider 里直接展示完整磁盘路径文本（溢出省略）+「切换文件夹」按钮，既丑又暴露内部路径 | `App.tsx:109-111` |
| 5 | 零主题定制：`ConfigProvider` 仅设 zhCN，无任何 token；全局只有 47 行 `styles.css`，其余全是组件内联 style | `main.tsx:18`、`styles.css` |
| 6 | 录入页首屏被 Excel 导入大面板（560 行逻辑的 Card）和 AI 面板占据，ProForm 挤在 `maxWidth:720` 左侧窄列，桌面宽度浪费 | `EntryFormView.tsx:113-126`、`ExcelImportPanel.tsx` |
| 7 | 录入两行 posting 无借贷语义视觉（纯三列平铺：账户/金额/货币），自动平衡已实现但无实时差额提示 | `EntryFormView.tsx:149-205` |
| 8 | 明细表无金额列（`LedgerEntryRow` 数据层即无 amount 字段）、无时间范围筛选、无排序保证说明；「清空账本」危险按钮与索引状态卡混在流水页顶部 | `EntriesView.tsx:30-45,104-105`、`index-builder.ts:30-39` |
| 9 | 报表页无指标卡、无同比、图表无 loading 骨架（Spin 罩全页） | `ReportsView.tsx:113` |
| 10 | 冷启动白屏：`if (!ready \|\| !workspace) return null` —— 首次 IPC 返回前整窗空白 | `App.tsx:88` |
| 11 | 窗口默认 1280×800（= 需求的最小值），无 minWidth/minHeight 约束 | `src/main/index.ts:30-31` |
| 12 | 账户管理藏在录入页一个小按钮的 760px Modal 里，三个 26%/30%/34% 定宽 Input 拼一行，无分类树 | `EntryFormView.tsx:141-143`、`AccountSettingsModal.tsx:183-188` |
| 13 | 「对账」「总览」「设置」页面不存在；最近账本能力主进程已实现（`workspace:recents` 通道 + `loadRecents()`）但 preload 未暴露，渲染端拿不到 | `ipc-handlers-workspace.ts:2`、`workspace-store.ts:24`、`preload/index.ts:9-11` |

---

## 一、整体优化思路

信息架构从「功能堆叠」重构为「总览 → 操作 → 追溯」三层：新增总览页作为财务驾驶舱，交易页合并录入与流水形成操作主战场，对账/报表页承接追溯与输出。框架采用 **ProLayout** 承载固定 Header/Sider、菜单收起与路由容器，`react-router-dom` HashRouter 路由化，仅主内容区滚动并带纯 CSS 过渡。视觉上用 antd Design Token（深蓝主色 + 青橙借贷色）与 Less 分层样式建立统一规范：数字右对齐、千分位、tabular-nums、红色仅表负数。冷启动以 index.html 内联 Splash + 分级 Skeleton 消除白屏。全程零业务逻辑改动，账本隔离依赖既有「切换即 reload」机制。

---

## 二、视觉规范建议

### 2.1 设计基调

**Minimalism & Swiss Style**（设计系统检索结论）：高对比、网格化、留白克制、去装饰 —— 契合财务软件「信任与权威」。避免：AI 紫粉渐变、圆润卡通化、emoji 当图标。

### 2.2 Design Token 表（antd 5 `theme` token，`src/renderer/src/theme/tokens.ts` 单源）

| Token | 值 | 用途 / 理由 |
|---|---|---|
| `colorPrimary` | `#1d39c4`（geekblue-7） | 主色：比 antd 默认蓝 `#1677ff` 更沉稳，贴近传统财务软件（用友/金蝶均为深蓝系），传达权威感 |
| `colorSuccess` | `#389e0d` | 校验通过、同步成功 |
| `colorWarning` | `#d46b08` | 冲突待处理、索引异常 |
| `colorError` | `#cf1322` | **仅**用于错误与负数/赤字，不用于支出语义 |
| `colorInfo` | `#08979c`（cyan-7） | 流入/收入方向色 |
| `colorTextBase` | `#0f172a` | 正文改近黑蓝（slate-900），比纯黑柔和 |
| `colorBgLayout` | `#f5f7fa` | 布局底色，与卡片白形成层次 |
| `borderRadius` | `6` | 桌面端克制圆角 |
| `fontSize` | `14` | 基准字号；`12` 仅辅助文字 |
| `wireframe` | `false` | 实底卡片 |

**借贷/收支功能色（色盲安全）**：

| 语义 | 色 | 规则 |
|---|---|---|
| 流入/贷方增加 | 青 `#08979c` | 与流出成对出现，另配 ↑/↓ 图标辅助，不单靠颜色 |
| 流出/借方增加 | 橙 `#d46b08` | 同上 |
| 负数/赤字 | 红 `#cf1322` + `-` 前缀 | 红色语义唯一化 |
| 平衡校验 | 绿/红 | 差额为 0 绿色对勾，否则红色差额提示 |

青/橙对红绿色盲仍可由明度差区分，且关键处都有图标/文字冗余编码 —— 满足「不得仅靠红绿区分」红线。

### 2.3 字体与数字

CSP `default-src 'self'` **禁止 remote 字体**，检索结果中的 Google Fonts（Lexend）不可用，沿用系统栈并加数字优化：

```less
// styles/base.less
:root {
  font-family: 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;
}
.num {                       // 所有金额单元格挂此 class
  font-variant-numeric: tabular-nums;   // 等宽数字，多行金额纵向对齐
  text-align: right;
  font-family: 'Consolas', 'Segoe UI', monospace; // 金额可换等宽栈，可选
}
.num-negative { color: #cf1322; }       // 仅负数
```

千分位格式化（`src/renderer/src/utils/format.ts`，纯字符串处理防精度丢失，禁 `Number`/`parseFloat`）：

```ts
/** '1234567.89' → '1,234,567.89'；负数原样带符号；空值返回 '—' */
export function formatAmount(raw: string | null | undefined): string {
  if (!raw || !/^-?\d+(\.\d+)?$/.test(raw.trim())) return '—'
  const neg = raw.startsWith('-') ? '-' : ''
  const [int, frac] = raw.replace(/^-/, '').split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg}${grouped}${frac ? '.' + frac : ''}`
}
```

### 2.4 间距与字号阶梯

间距 4 基数：`4 / 8 / 12 / 16 / 24 / 32`（卡片内 16、卡片间 16、区块间 24、页头下 16）；字号 `12 / 14 / 16 / 20 / 28`（28 仅 Dashboard 指标卡 Statistic）。

### 2.5 明暗主题

`ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: THEME_TOKENS }}`，偏好存 `localStorage`（UI 层状态，不入账本）。注意深色下需覆写 `colorBgLayout`/`colorBgContainer` 由 dark 算法接管，自定义功能色用 `token` 覆写保证对比度。**P2 落地**。

### 2.6 Less 文件组织（新增 devDependency `less`，Vite 内置支持零配置）

```
src/renderer/src/styles/
  tokens.less        // --bw-* CSS 变量（与 theme/tokens.ts 同步，文件头互指）
  base.less          // 字体栈、.num、滚动条、通用空态
  layout.less        // ProLayout 覆写、页面切换动画、Header 内间距
  views/entry.less  entries.less dashboard.less accounts.less reconcile.less reports.less
```

同步约定：antd token 是 JS 对象（色板算法需要真实色值，不能用 CSS var），Less 侧只放**布局/组件级**样式与同名 CSS 变量作运行期兜底，两文件头部注释互相指向；可加一个 Vitest 单测断言关键色值一致。

---

## 三、路由表（HashRouter，唯一新增 runtime 依赖 `react-router-dom`）

| path | 页面 | 菜单项 | 现状映射 |
|---|---|---|---|
| `/` | 总览 Dashboard | 总览 | **新增**（模块 2） |
| `/entry` | 录入凭证 | 交易 ▸ 录入凭证 | `EntryFormView` |
| `/entries` | 交易流水 | 交易 ▸ 交易流水 | `EntriesView`（剥离索引状态卡） |
| `/accounts` | 账户（科目管理） | 账户 | **新增页**（吸收 `AccountSettingsModal`，模块 4） |
| `/reconcile` | 对账（余额表/明细账） | 对账 | **新增**（模块 5） |
| `/reports` | 报表 | 报表 | `ReportsView` |
| `/editor` | 源文件编辑器 | 工具 ▸ 编辑器 | `EditorView` |
| `/settings` | 设置 | Sider 底部 | **新增聚合页**（同步/AI/更新/索引状态卡迁入） |
| `/merge` | 三路合并 | 不入常驻菜单，有冲突时 Sider 顶部出红色条件项 | `ConflictView`（沿用现条件渲染逻辑） |
| `*` | — | — | `<Navigate to="/" replace />` |

- **菜单高亮**：`items` 用 `key=path`，`selectedKeys={[location.pathname]}`；`/merge` 无菜单时由 `conflict` 条件项承接。
- **滚动复位**：`Content` 滚动容器 ref，`useEffect(() => ref.current?.scrollTo(0,0), [location.pathname])`。
- **切换动画（纯 CSS）**：以 `location.pathname` 为 key 重挂内容容器，180ms 淡入上移；`prefers-reduced-motion` 下关闭（见 layout.less）。仅内容区参与，Header/Sider 静止。
- **账本上下文**：**推荐全局 zustand + 切换后整页 reload（维持现状机制）**，不采用 `/ledger/:id/` 前缀路由。理由：CLAUDE.md 关键约束 9 规定切换工作目录即整页 reload、状态不得跨目录串扰 —— 前缀路由的「同 URL 参数切换数据」语义与 reload 机制冲突，且 reload 后 URL 里的 ledgerId 反而成为过期脏数据。
- **默认与 404**：`/` 即总览；`*` 重定向总览。

路由骨架（`App.tsx` 重写后核心，≤30 行）：

```tsx
const router = (
  <HashRouter>
    <ProLayout
      route={{ routes: MENU_ROUTES }}            // 菜单即路由表单源
      location={{ pathname }}
      menuItemRender={(item, dom) => <Link to={item.path!}>{dom}</Link>}
      headerContentRender={() => <LedgerSwitcher />}   // 模块 8 主入口
      avatarProps={{ icon: <SettingOutlined />, render: () => <Link to="/settings">设置</Link> }}
    >
      <div ref={contentRef} className="page-scroll">
        <div key={pathname} className="page-enter">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/entry" element={<EntryFormView />} />
            <Route path="/entries" element={<EntriesView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </ProLayout>
  </HashRouter>
)
```

```less
// styles/layout.less —— 仅主内容区滚动 + 页面切换动画
.page-scroll { height: calc(100vh - 56px); overflow-y: auto; padding: 16px 24px; }
.page-enter { animation: bw-page-in 180ms ease-out; }
@keyframes bw-page-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) { .page-enter { animation: none; } }
```

**ProLayout vs 纯 antd Layout 取舍**：ProLayout 内建菜单收起（collapsed / collapsedButtonRender）、fixedHeader、内容容器、菜单-路由映射与面包屑，覆盖本方案全部框架需求，自写量≈0；纯 `Layout+Sider` 需手写收起联动、固定定位、滚动容器三块逻辑。**结论：框架用 ProLayout；内容区滚动容器与动画自写（ProLayout 的 contentStyle 不含滚动复位逻辑）**。表格用 ProTable（流水/对账页自带筛选工具栏与刷新），Dashboard 指标卡用纯 antd（Statistic + Card 足够）。

---

## 四、分模块优化方案（P0 → P1 → P2）

### 模块 1 全局框架与导航（P0）

**现状问题**：见总览表 #1、#2、#3、#4、#11。

**优化建议**
- 重写 `App.tsx` 为 ProLayout + HashRouter（上节骨架），删除 `display:none` 常驻挂载与 `calc(100vh-112px)` 魔法数。
- Header 布局收敛为四区：`[账本切换 Dropdown] [弹性留白] [＋新建记账(跳/entry)] [同步状态 Popover] [更新 Badge·AI 徽标·设置]` —— 索引 Tag、同步四元素全部收进 Popover，Header 视觉元素从 8 → 5。
- Sider：logo + 分组菜单（总览 / 交易▸录入·流水 / 账户 / 对账 / 报表 / 工具▸编辑器）+ 底部设置入口；**磁盘路径从 Sider 移除**（账本下拉 hover tooltip 显示路径）。
- 窗口：`src/main/index.ts` 改 `width:1440, height:900, minWidth:1280, minHeight:800, useContentSize:true`。

**组件选型**：ProLayout（框架）、Dropdown（账本）、Popover（同步状态）、Badge（冲突/更新角标）、Link（菜单渲染）。

**关键代码**：Header 状态区收敛 ≤30 行：

```tsx
// views/HeaderStatusArea.tsx
const items: MenuProps['items'] = [
  { key: 'index', label: <Space>索引 <Tag color={STATUS_COLOR[status?.status ?? 'missing']}>{status?.status}</Tag></Space>, disabled: true },
  { type: 'divider' },
  { key: 'refresh', icon: <ReloadOutlined />, label: '重建索引', onClick: handleRefreshIndex },
  { key: 'conflict', icon: <CloudOutlined />, label: '冲突合并', hidden: !conflict, onClick: goMerge },
  { key: 'cfg', icon: <SettingOutlined />, label: '同步设置', onClick: openSync },
]
return (
  <Space size={4}>
    <Dropdown menu={{ items }}><Button type="text" icon={<CloudOutlined />} /></Dropdown>
    <Badge dot={!!updateAvailable}><Button type="text" icon={<CloudDownloadOutlined />} onClick={openUpdate} /></Badge>
  </Space>
)
```

---

### 模块 3 交易页：录入凭证 + 交易流水（P0）

**现状问题**：见总览表 #6、#7、#8。

**优化建议（录入，`/entry`）**
- 桌面双栏 `flex: 3 / 2`（≥1280 有效）：**左栏**凭证表单卡片化 —— ① 凭证头（日期/标志/交易对象/说明，2 列栅格）② 分录区：两行改**借贷双栏卡**（上行蓝边「付方/资产减少」，下行橙边「收方/资产增加」，行内 账户(55%) 金额(30%) 货币(15%)）③ 平衡指示条 ④ 提交区（写入账本 + Ctrl+Enter 快捷键 + 重置）。
- **Excel 导入与 AI 面板移出首屏**：页头放两个次要按钮「Excel 导入」「AI 录入」，各自开 Drawer（组件不改，仅容器从 Card 换 Drawer，逻辑零改动）。
- 平衡提示：`Form.useWatch` 已有，新增 `<BalanceHint>` 实时显示差额（复用 `computeBalancingNumber`），绿色「已平衡 ✓」/ 红色「差额 X」。
- 科目下拉按五大类分组：`options` 由 `accountOptions` 按 `value` 首段分组（`Assets` → label「资产」…）。

**优化建议（流水，`/entries`）**
- 索引状态卡迁往 `/settings`；页头 = 时间筛选（Segmented：今日/本周/近7天/本月 + DatePicker.RangePicker 自定义）+ 重建索引按钮（危险操作「清空账本」迁设置页）。
- ProTable：列 日期/标志/类型/交易对象/说明/账户；`date` 列默认 `desc` 倒序；金额列**标注**：`LedgerEntryRow` 无 amount 字段，见「超 UI 层清单 #1」。
- 时间筛选现状受限于 `ListEntriesParams` 仅 limit/offset（`index-builder.ts:41-44`）→ P0 先落前端方案：以 `total` 上限内分页拉取 + `dataSource` 过滤；长期见「超 UI 层清单 #2」。

**组件选型**：ProForm + Form.List（保持，写路径唯一不动）、Drawer、Segmented、RangePicker、ProTable、Statistic。

**关键代码**：分录行借贷语义 + 平衡提示（≤30 行）：

```tsx
// views/entry/PostingRowCard.tsx
const ROW_META = [
  { tone: 'debit',  icon: <ArrowUpOutlined />,  placeholder: '资金减少 / 支出方' },
  { tone: 'credit', icon: <ArrowDownOutlined />, placeholder: '资金增加 / 收入方' },
] as const

export function PostingRowCard({ index, currencyOptions, accountOptions }: Props) {
  return (
    <div className={`posting-row posting-row--${ROW_META[index].tone}`}>
      <div className="posting-row__head">{ROW_META[index].icon}{ROW_META[index].placeholder}</div>
      <Form.Item name={[index, 'account']} rules={[{ required: true }]} style={{ flex: 5.5 }}>
        <Select showSearch optionFilterProp="label" options={groupedAccountOptions(accountOptions)} />
      </Form.Item>
      <Form.Item name={[index, 'number']} style={{ flex: 3 }}>
        <InputNumber stringMode placeholder="0.00" style={{ width: '100%' }} controls={false} />
      </Form.Item>
      <Form.Item name={[index, 'currency']} style={{ flex: 1.5 }}>
        <AutoComplete options={currencyOptions} placeholder="CNY" />
      </Form.Item>
    </div>
  )
}
```

```less
// styles/views/entry.less
.posting-row { display: flex; gap: 8px; padding: 8px 12px; border-radius: 6px;
  border-left: 3px solid transparent; background: @bw-bg-secondary;
  &--debit  { border-left-color: @bw-blue; }
  &--credit { border-left-color: @bw-orange; }
  &__head   { width: 100%; font-size: 12px; color: @bw-text-secondary; }
}
```

---

### 模块 8 账本（工作目录）切换（P0）

**现状问题**：见总览表 #4、#13；主进程已有 `workspace:recents` 通道与 `loadRecents()`（上限 10），仅差 preload 暴露一行。

**切换交互方案对比**

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A. Header 下拉（主入口，采纳）** | 左上当前账本名按钮 → Dropdown：当前账本（✓ + 路径 tooltip）/ 最近账本（recents）/ 「浏览…打开其他目录」/ 「账本管理」 | 零学习成本、占位 1 行；recents 数据现成 |
| B. 快捷弹层（辅助，采纳） | `Ctrl+K` 打开轻量 Modal（Input 自动焦点 + recents 过滤列表 + Enter 切换），antd Modal + Input 自制，无新依赖 | 高频用户提效；成本低 |
| C. 独立管理页（辅助，采纳为 `/settings` 内区块） | recents 网格卡片 + 打开目录按钮 | 「重命名/归档/删除账本」需新增主进程通道，见「超 UI 层清单 #3」 |

**组件选型**：Dropdown + Menu（主入口）、Modal + Input（Ctrl+K）、Tooltip（路径）、CheckOutlined（当前项）。

**关键代码**：账本下拉（≤30 行）：

```tsx
// views/LedgerSwitcher.tsx
const [recents, setRecents] = useState<string[]>([])
useEffect(() => { void window.beanwise.getWorkspaceRecents().then(setRecents) }, [])

const items: MenuProps['items'] = [
  { key: 'current', icon: <CheckOutlined />, label: basename(workspace.current!) },
  ...recents.filter(p => p !== workspace.current).map(p => ({ key: p, label: basename(p) })),
  { type: 'divider' },
  { key: 'browse', icon: <FolderOpenOutlined />, label: '浏览其他目录…', onClick: openAndReload },
]
return (
  <Dropdown menu={{ items, onClick: ({ key }) => key !== 'current' && switchTo(key) }}>
    <Button type="text" size="large" icon={<SwapOutlined />}>
      <Typography.Text strong>{basename(workspace.current!)}</Typography.Text>
    </Button>
  </Dropdown>
)
```

**防误操作设计**
- 切换目标 = 当前账本 → 忽略；否则 `Modal.confirm`：「切换到 XXX？未提交的录入内容将丢失」（仅当录入表单 dirty 时出现，`form.isFieldsTouched()`）。
- 切换成功沿用 `window.location.reload()`（CLAUDE.md 约束 9，不新增软切换路径）。
- 数据隔离提示：下拉底部固定说明「每个目录独立账本与索引，切换后整页重载」。

---

### 模块 2 总览 Dashboard（P1，新增 `/`）

- **指标卡行**（4 × Card + Statistic）：总资产 / 总负债 / 净资产（`report:balances` 前端按顶层类汇总，或 `report:net-worth` 末点）+ 本月收支（`report:income-expense` granularity=month 取当月点，收入青色 ↑、支出橙色 ↓）。**全部零 IPC 变更可落地**。
- **时间粒度**：Segmented 年/月/日/周 + RangePicker 自定义。**现状 `ReportGranularity` 仅 `month | year`**（`ipc.ts:450`）→ UI 先落「月/年 + 自定义范围」；日/周需扩展 report 通道，见「超 UI 层清单 #4」。
- **同比**：再查一份去年序列（同接口，`startYear/endYear` 错位 12 月对齐），趋势图叠加虚线「去年同期」；指标卡展示同比 ±%（涨青跌橙，**负数才用红**）。
- **图表筛选统一**：页面顶部单一筛选条（粒度 + 范围），store 分发到指标卡与图表 —— 与流水页快捷段共用一个 `useTimeRange` hook，杜绝各图表各自为政。
- **加载态**：每张卡独立 `Skeleton`（active），不整页 Spin。

**组件选型**：Card + Statistic、Segmented、DatePicker.RangePicker、Line（Ant Charts）、Skeleton。

---

### 模块 5 对账页（P1，新增 `/reconcile`）

- **科目余额表**（Tabs ①）：`report:balances` 树表 —— 列：账户（树）/ 余额（多币种，`formatAmount` + 右对齐）；顶部货币筛选 + RangePicker（`ReportBalancesParams` 已含起止）。标准「期初/发生/期末」三栏式需期初聚合能力，见「超 UI 层清单 #5」。
- **明细账**（Tabs ②）：账户 TreeSelect → 该账户分录表。**现状 `ListEntriesParams` 无 account 过滤**，全量拉取不可行（limit 上限 1000）→ 见「超 UI 层清单 #2」；落地前此 Tab 显示「需要索引查询支持」Empty 兜底。
- **银行对账**：无此业务功能，本方案不虚构；Tab 预留说明位。
- 数字规范：全部 `.num` class（右对齐 + tabular-nums + 千分位 + 负数红）。

**组件选型**：Tabs、ProTable（sticky 表头 `scroll:{y}`）、TreeSelect、Tag（币种）。

### 模块 7 配色与视觉系统（P1）

即第二节全部内容（Token 表 / 借贷色 / 字体 / 间距 / 明暗主题 / Less 组织），各模块直接引用不再重复。补充落地顺序：tokens.ts + tokens.less + base.less 属 **Quick Win #2**，先行落地，其余模块全部消费它。

### 模块 9 冷启动与加载体验（P1）

- **白屏治理**：`index.html` 写内联 `<style>` Splash（豆账 logo 字标 + 底色 `#f5f7fa` + 呼吸点动画）—— 生产 CSP `style-src 'unsafe-inline'` 已放行（CLAUDE.md 约束 8），**零脚本**、React mount 后由 App `useEffect` 移除。`ready` 判定前不再 `return null`，而是渲染 ProLayout 框架 + 内容区 Skeleton（框架不等待数据）。
- **加载态分级**：启动 = Splash；页面 = 卡片级 Skeleton（Dashboard 指标卡/流水表/图表各自占位，防布局跳变：Skeleton 高度对齐最终内容）；局部 = Button loading / Spin（提交、重建索引）。
- **失败兜底**：现状 `workspaceError` 红字 div（`App.tsx:85`）→ 改 antd `Result status="error"` + 「重试」按钮（重新拉 `getWorkspaceStatus`）+「更换目录」入口；索引失败沿用 Alert + 重建入口（已有）。
- **量化验收**：Splash 可见 ≤100ms（窗口创建即显）；框架首帧 ≤300ms；骨架→数据就绪渐进填充；白屏时长 0；`npm run dev` 下 Splash 与主界面切换无闪烁（一次性过渡 CSS opacity 200ms）。
- **性能建议（单独列出）**：UI 层 —— Splash 前置、框架先行、卡片级懒加载（Dashboard 图表 `React.lazy`）；**超 UI 层** —— 主进程在 `ready-to-show` 前完成 `activateWorkspace` 预热、SQLite 连接预建（涉及启动时序，需另行决策）。

---

### 模块 4 账户（科目）管理（P2，新增 `/accounts`）

- `AccountSettingsModal` 整体升级为页面：左栏五大类 Tab/树（Assets/Liabilities/Equity/Income/Expenses 中文分组，数据来自 `accountOptions` 首段分组）；右栏 ProTable 编辑（名称/用途/路径/删除），新增表单收进页头「新增科目」Drawer（现 26%/30%/34% 定宽 Input 行废弃）。
- 录入页「账户设置」小按钮 → 跳转 `/accounts`。
- 期初余额、启用/停用：`AccountEntry` 无此字段 —— 增加字段属数据结构变更（红线允许增不改删），见「超 UI 层清单 #6」。

### 模块 6 财务报表（P2，`/reports` 增强）

- **资产负债表（账户式）**：纯前端可落 —— `report:balances` 按 `Assets:*` 拆左栏、`Liabilities:*`+`Equity:*` 拆右栏，双栏表 + 两侧合计行；贴近正式报表的表格线与「资产 = 负债 + 权益」校验行。
- **利润表（报告式）**：`report:income-expense` 上下结构（收入明细 → 小计 → 支出明细 → 净利润），月份选择器。
- **现金流量表**：无对应数据源，见「超 UI 层清单 #7」，本方案不虚构。
- 排版：白底卡片 + 报表标题栏（账本名 / 期间 / 单位：CNY）+ 导出 PDF（`webContents.printToPDF` 需新增 IPC 通道，见「超 UI 层清单 #8」）。

### 设置页（P2，新增 `/settings`，承接各处迁移物）

分组卡片：账本管理（recents 列表 + 清空账本【从流水页迁入，保留二级确认】）/ 同步（SyncSettingsModal 内容内联或保留 Modal）/ AI（AiSettingsModal 同）/ 索引状态卡（从流水页迁入）/ 关于与更新（UpdateModal 内容）。

---

## 五、交互细节清单

1. **金额规范全局统一**：`.num` class（右对齐 + tabular-nums + 千分位），负数红 + `-`；空值 `—`；录入 `stringMode` 链路不动。
2. **Ctrl+Enter 提交凭证**、`Ctrl+K` 账本切换、Esc 关 Drawer —— 录入高频操作全键盘可达。
3. **平衡指示条**：分录金额变动 100ms 内显示「已平衡 ✓ / 差额 X」（复用现有 `computeBalancingNumber`），提交前视觉兜底。
4. **空状态带行动**：流水空 → Empty +「录入第一笔」跳 `/entry`；报表空 → Empty + 说明先在设置确认索引状态。
5. **骨架防跳变**：Skeleton 高度对齐最终内容（指标卡 112px、表格 8 行、图表 280px），数据就绪无布局位移（CLS≈0）。
6. **危险操作分级**：清空账本保留二级确认并加红色 `okButtonProps.danger`（已有）+ 迁入设置页远离日常流；切换账本 dirty 检查确认。
7. **同步/索引状态可解释**：所有状态 Tag/图标可点（Popover 展开原因 + 最近错误 + 动作按钮），不让用户猜状态含义。
8. **表格体验**：`scroll.y` 固定视口高 + sticky 表头；列宽自适应（payee/narration `ellipsis:true` + Tooltip）；页码 `showTotal`。
9. **reduced-motion**：页面切换动画、Splash 呼吸点、Skeleton 均响应 `prefers-reduced-motion`。
10. **焦点闭环**：Drawer/Modal 关闭后焦点回触发按钮（antd 默认行为，勿破坏）；表单校验错误就近显示并 `scrollToField`。

---

## 六、可优先落地的 Quick Wins（按投入产出比）

1. **ProLayout + HashRouter 路由化 + Header 收敛**（≈1 天）：删 `display:none` 挂载、修整页滚动、Header 8→5 元素 —— 观感与结构质变，是其余一切的地基。
2. **Token 体系 + Less 脚手架**（≈半天）：`theme/tokens.ts` + `styles/*` 分层 + `.num` 金额类 —— 全局视觉统一一步到位，后续模块纯消费。
3. **录入页双栏重排 + Excel/AI 收进 Drawer + 平衡提示条**（≈1 天）：首屏回归「录入」本身，桌面宽度利用率翻倍。
4. **明细页瘦身 + 时间快捷筛选 + 账本下拉（recents）**（≈1 天）：流水更像「流水」，账本切换达到财务软件心智。
5. **Splash + 卡片级 Skeleton + 失败 Result 兜底**（≈半天）：白屏归零，冷启动体验达标。

---

## 七、依赖纪律与超 UI 层清单（需你决策）

**依赖**：runtime 仅新增 `react-router-dom`（HashRouter）。另需 devDependency `less`（Vite 内置 less 编译，零配置）—— 属构建期工具非运行时依赖，鉴于你明确要求样式用 Less，默认采纳；如严格执行「零新增依赖」字面约束请告知，我可改回纯 CSS（以 CSS 变量替代 Less 变量）。

**超 UI 层清单**（不擅动，逐项请决策；均为「新增能力」，不触碰已有 API 语义与数据结构）：

| # | 需求 | 建议实现 | 影响面 |
|---|---|---|---|
| 1 | 流水/明细表显示金额列 | `index-builder` 查询补 `amount/currency` 字段（新可选返回字段） | 主进程查询 + 类型 |
| 2 | 流水时间筛选、明细账账户过滤 | `ListEntriesParams` 增可选 `account?/dateFrom?/dateTo?`（新增可选参数，旧调用不受影响） | 主进程 SQL + preload 透传 |
| 3 | 账本重命名/归档/删除 | 新增 workspace 通道（目录复制/改名 + store 更新） | 主进程新通道 |
| 4 | Dashboard 日/周粒度 | `ReportGranularity` 增 `'day' \| 'week'` | Python 聚合 + IPC |
| 5 | 三栏式科目余额表（期初/发生/期末） | 新增 report 聚合通道 | Python/SQLite |
| 6 | 科目期初余额、启停用 | `accounts.json` AccountEntry 增字段（红线允许增加） | shared 类型 + 表单 |
| 7 | 现金流量表 | 新增收支现金流分类聚合 | Python/SQLite |
| 8 | 报表导出 PDF | `webContents.printToPDF` 新通道 | 主进程新通道 |
| 9 | 窗口默认 1440×900 + 最小约束 | `src/main/index.ts` 一行改动 | 主进程 |
| 10 | 启动预热（ready-to-show 前完成 activateWorkspace） | 启动时序调整 | 主进程 |

**红线自查**：不改动任何业务写路径（录入仍走 ProForm 提交 → `add-entry`，Excel/AI 仅换容器）；不改数据库结构与已有 API；`HashRouter` 适配 `file://`；路由仅 UI 层组织，零业务逻辑入路由；所有新增页面有 Empty/失败兜底，无功能删除（仅迁移：索引状态卡→设置、清空账本→设置、Excel/AI→Drawer）。

**测试影响**：`e2e/` 七个 spec 的选择器需随 DOM 结构核对（尤其 smoke/ledger-index 的 Sider 菜单文本、reports 的图表容器）；改造按 spec 逐个跑 `npm run test:e2e` 回归，测试账本目录 `F:\BeanWiseData\test`。
