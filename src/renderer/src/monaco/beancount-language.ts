import type * as Monaco from 'monaco-editor'

export const BEANCOUNT_LANGUAGE_ID = 'beancount'

/**
 * beancount monarch 词法规则（M5 定稿）。规则顺序敏感：账户（含冒号）先于货币（无冒号）。
 * 导出为纯数据，便于单测断言 token 覆盖与顺序。
 */
export const BEANCOUNT_TOKENIZER: Monaco.languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      [/\s+/, 'white'],
      [/;.*$/, 'comment'],
      [/^(?:option|plugin|include|pushtag|poptag|note|balance|open|close|event|query|custom|commodity|price)\b/, 'keyword'],
      [/\d{4}-\d{2}-\d{2}/, 'number.date'],
      // M5 终审：tag/link 必须先于 type.flag（monarch 首中即止，'#' 在 flag 字符类 [*!#%&] 内，
      // flag 在前会先消费 '#tag' 的 '#'，tag 规则不可达；'^' 不在 flag 类中故 link 原可达）
      [/#[A-Za-z0-9\-_/.]+/, 'tag'],
      [/\^[A-Za-z0-9\-_/.]+/, 'link'],
      [/[*!#%&]/, 'type.flag'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/\b[A-Z][A-Za-z0-9-]*(?::[A-Z][A-Za-z0-9-]*)+/, 'type.account'],
      [/-?\d+(?:\.\d+)?/, 'number'],
      [/\b[A-Z][A-Z0-9']{1,8}\b/, 'currency']
    ]
  }
}

/** M5：注册 beancount 语言（幂等；monaco 注入便于单测传 mock 对象） */
export function registerBeancountLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((l) => l.id === BEANCOUNT_LANGUAGE_ID)) return
  monaco.languages.register({ id: BEANCOUNT_LANGUAGE_ID })
  monaco.languages.setMonarchTokensProvider(BEANCOUNT_LANGUAGE_ID, BEANCOUNT_TOKENIZER)
  monaco.editor.defineTheme('beanwise', {
    base: 'vs',
    inherit: true,
    colors: {},
    rules: [
      { token: 'comment', foreground: '6a737d' },
      { token: 'keyword', foreground: 'd73a49' },
      { token: 'string', foreground: '032f62' },
      { token: 'number.date', foreground: '005cc5' },
      { token: 'number', foreground: '005cc5' },
      { token: 'type.account', foreground: 'e36209' },
      { token: 'currency', foreground: '6f42c1' },
      { token: 'type.flag', foreground: 'd73a49' },
      { token: 'tag', foreground: '22863a' },
      { token: 'link', foreground: '22863a' }
    ]
  })
}
