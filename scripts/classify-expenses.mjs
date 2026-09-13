#!/usr/bin/env node
// 用法：
//   node scripts/classify-expenses.mjs --dry-run
//   node scripts/classify-expenses.mjs --apply
//
// 默认处理 F:\BeanWiseData\test。--apply 会先备份账本、账户库和导入模板。
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  EXPENSE_ACCOUNT_RENAMES,
  classifyExpense,
  flattenExpenseTaxonomy
} from '../src/main/expenses/expense-taxonomy.ts'
import {
  buildExpenseAccountLibrary,
  rewriteExpenseAccounts
} from '../src/main/expenses/ledger-expense-migration.ts'

function parseArgs(argv) {
  const options = {
    apply: false,
    ledger: 'F:/BeanWiseData/test/main.beancount',
    accounts: '',
    templates: ''
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--dry-run') options.apply = false
    else if (arg === '--ledger') options.ledger = argv[++i]
    else if (arg === '--accounts') options.accounts = argv[++i]
    else if (arg === '--templates') options.templates = argv[++i]
    else throw new Error(`未知参数：${arg}`)
  }
  if (!options.ledger) throw new Error('--ledger 不能为空')
  return options
}

function timestamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function writeAtomic(filePath, content) {
  const tmp = `${filePath}.tmp-classify-expenses`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, filePath)
}

function backup(filePath, suffix) {
  if (!existsSync(filePath)) return null
  const backupPath = `${filePath}.bak-${suffix}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

function replaceTemplateAccounts(value) {
  if (typeof value === 'string') return EXPENSE_ACCOUNT_RENAMES[value] ?? value
  if (Array.isArray(value)) return value.map(replaceTemplateAccounts)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTemplateAccounts(item)]))
  }
  return value
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const ledgerPath = resolve(options.ledger)
  const workspace = dirname(ledgerPath)
  const accountsPath = resolve(options.accounts || join(workspace, '.beanwise', 'accounts.json'))
  const templatesPath = resolve(options.templates || join(workspace, '.beanwise', 'excel-import-templates.json'))
  const suffix = `expense-classification-${timestamp()}`

  if (!existsSync(ledgerPath)) throw new Error(`账本不存在：${ledgerPath}`)
  const before = readFileSync(ledgerPath, 'utf8')
  const rewritten = rewriteExpenseAccounts(before, classifyExpense, EXPENSE_ACCOUNT_RENAMES)

  const accountFile = JSON.parse(readFileSync(accountsPath, 'utf8'))
  const accountEntries = Array.isArray(accountFile.accounts) ? accountFile.accounts : []
  const nextAccounts = buildExpenseAccountLibrary(accountEntries, flattenExpenseTaxonomy())
  const nextAccountFile = { ...accountFile, accounts: nextAccounts }

  let nextTemplatesFile = null
  if (existsSync(templatesPath)) {
    const templateFile = JSON.parse(readFileSync(templatesPath, 'utf8'))
    nextTemplatesFile = replaceTemplateAccounts(templateFile)
  }

  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    ledger: ledgerPath,
    accounts: accountsPath,
    templates: nextTemplatesFile ? templatesPath : null,
    changedPostings: rewritten.changedPostings,
    skippedInvestmentLoss: rewritten.skippedInvestmentLoss,
    usedExpenseAccounts: Object.keys(rewritten.usedAccountDates).length,
    accountTop: Object.entries(rewritten.accountCounts)
      .sort(([, countA], [, countB]) => countB - countA || 0)
      .slice(0, 20)
      .map(([account, count]) => ({ account, count })),
    accountLibraryEntries: nextAccounts.length
  }

  if (options.apply) {
    summary.backups = {
      ledger: backup(ledgerPath, suffix),
      accounts: backup(accountsPath, suffix),
      templates: nextTemplatesFile ? backup(templatesPath, suffix) : null
    }
    writeAtomic(ledgerPath, rewritten.content)
    writeAtomic(accountsPath, `${JSON.stringify(nextAccountFile, null, 2)}\n`)
    if (nextTemplatesFile) writeAtomic(templatesPath, `${JSON.stringify(nextTemplatesFile, null, 2)}\n`)
  }

  console.log(JSON.stringify(summary, null, 2))
}

main()
