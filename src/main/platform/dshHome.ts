import { homedir } from 'node:os'
import { join } from 'node:path'
import { readSettings } from './settings'

/**
 * dsh 数据目录（`DSH_HOME`）。
 *
 * 与 dsh 自身的规则一致：先看 `DSH_HOME` 环境变量，没有才落到 `~/.dsh`。
 * 认这个变量有两个好处：
 *  1. dsh 的行为就是这样，跟着它走不会出现"应用看的目录和 dsh 用的不是同一个"；
 *  2. 测试可以把写入指向一个临时目录，**不去动用户真实的插件补丁层**。
 */
export function dshHome(): string {
  /*
   * 优先级：**设置里填的** → `DSH_HOME` 环境变量 → `~/.dsh`。
   *
   * 设置优先，因为那是用户在界面上明确指定的最具体意图；环境变量次之（有些人靠它
   * 在多个数据目录之间切换）；都没有才落默认值。
   *
   * 这个函数同时决定两件事，所以只在这里改一处就够：
   *   ① 启动器自己读 profile 的位置（插件清单）
   *   ② 传给 dsh 子进程的 `DSH_HOME`
   */
  const fromSettings = readSettings().dshHome
  if (fromSettings !== '') return fromSettings
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * profile 目录。默认 `web`。
 *
 * 注意：插件与数据是**按 profile 隔离、不按 dsh 版本隔离**的 —— 同一份 profile 被所有
 * dsh 版本共用，这正是"换版本不用重装插件"的机制本身。
 */
export function profileDir(profile = 'web'): string {
  return join(dshHome(), 'profiles', profile)
}
