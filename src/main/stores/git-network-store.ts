/**
 * M12：本机 git 网络配置（代理 + 超时）的持久化。
 *
 * **机器级**（应用 electron-store `git-network`），刻意不随工作目录走：
 * 代理是机器/网络属性，换账本目录不该重填；对照 SyncConfig 按工作目录隔离存
 * `<workspace>/.beanwise/sync-config.json`（那份是账本仓库的属性）。
 * 配置里没有密钥（代理地址不许带用户名密码，见 core/git-network），故明文存即可。
 *
 * 单测/CI 注入内存实现（本模块 import electron-store → 不可进 vitest node 环境）。
 */
import Store from 'electron-store'
import type { GitNetworkConfig } from '../../shared/ipc'
import { normalizeGitNetwork } from '../core/git-network'

export interface GitNetworkStore {
  load(): GitNetworkConfig
  save(config: GitNetworkConfig): void
}

export class ElectronGitNetworkStore implements GitNetworkStore {
  private readonly store = new Store<{ network?: GitNetworkConfig }>({ name: 'git-network', defaults: {} })

  /** 读脏数据一律兜回默认值（直连 + 30s），绝不因配置损坏断掉同步 */
  load(): GitNetworkConfig {
    try {
      return normalizeGitNetwork(this.store.get('network'))
    } catch {
      return normalizeGitNetwork(null)
    }
  }

  save(config: GitNetworkConfig): void {
    this.store.set('network', normalizeGitNetwork(config))
  }
}
