import type { LauncherSettings } from '../../infrastructure/settings'
import { writeSettings } from '../../infrastructure/settings'
import { normalizeSettingsPatch } from '@shared/schemas/settings'
import { pushTagged } from '../terminal/logbus'

/**
 * 设置的**写入编排** —— 校验 → 落盘 → 记日志。
 *
 * 为什么在 `domain/settings/` 而不是 `infrastructure/`：
 *   这里承载的是**策略**（"来自渲染层的载荷该不该收、收了之后要不要记一行日志"），
 *   而不是机制。机制（JSON 文件读写、开机自启落注册表）在 `infrastructure/settings.ts`。
 *
 * 为什么原始读写**没有**跟着搬进来：`infrastructure/paths.ts` 与 `infrastructure/dshHome.ts`
 * 都是文件系统层却要读设置（版本池位置、DSH_HOME）。设置一旦搬进 domain，
 * 这两处就变成 infrastructure → domain 的反向依赖。所以：
 *   机制留在 infrastructure，策略放 domain。这是这一层划分的实际依据。
 */

/** 载荷不合法时抛这个，界面能拿到一句能看懂的话 */
export class InvalidSettingsPayloadError extends Error {
  constructor() {
    super('设置载荷不合法')
    this.name = 'InvalidSettingsPayloadError'
  }
}

/**
 * 应用一个来自渲染层的设置补丁，返回**写后的完整设置**。
 *
 * 载荷来自渲染层，**不能整包 trust 地写进磁盘**：先经
 * `@shared/schemas/settings` 逐字段收敛，认不出的字段丢掉。
 * 开机自启的落盘（注册表）由 `infrastructure/settings.ts` 负责，且只在打包后执行。
 */
export function applySettingsPatch(input: unknown): LauncherSettings {
  if (input === null || typeof input !== 'object') throw new InvalidSettingsPayloadError()

  const next = writeSettings(normalizeSettingsPatch(input))
  pushTagged(
    '启动器',
    `设置已保存（profile=${next.profile}${next.args ? ` · 参数 ${next.args}` : ''}）`
  )
  return next
}
