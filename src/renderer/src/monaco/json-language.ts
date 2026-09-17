import type * as Monaco from 'monaco-editor'

export const JSON_LANGUAGE_ID = 'beanwise-json'

/**
 * 受同步管理的 JSON 文件（账户库 / Excel 模板）在冲突视图里的高亮。
 *
 * 为什么不直接用 monaco 自带的 `json`：monaco-editor 0.56 的 `json` 是**worker 支撑的语言服务**
 * （`languages/features/json`，无 monarch 定义，词法/诊断都跑在 json worker 里），
 * 而本项目的 MonacoEnvironment.getWorker 恒返回通用 editor worker（monaco/setup.ts）——
 * 走 `json` 会把 JSON 语言服务路由到错误的 worker。自注册一份纯 monarch（零 worker 依赖）最稳。
 *
 * token 名沿用 beancount 主题已定义的 comment/string/number/keyword，无需新增主题规则。
 */
export const JSON_TOKENIZER: Monaco.languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      [/\s+/, 'white'],
      [/\/\/.*$/, 'comment'],
      [/"/, { token: 'string.quote', next: '@str' }],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/[{}[\],:]/, 'delimiter']
    ],
    str: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', next: '@pop' }]
    ]
  }
}

/** 注册 beanwise-json（幂等；monaco 注入便于单测传 mock 对象） */
export function registerJsonLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((l) => l.id === JSON_LANGUAGE_ID)) return
  monaco.languages.register({ id: JSON_LANGUAGE_ID })
  monaco.languages.setMonarchTokensProvider(JSON_LANGUAGE_ID, JSON_TOKENIZER)
}
