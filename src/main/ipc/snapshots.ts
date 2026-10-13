import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { SNAPSHOT_CHANNELS } from '@shared/constants/channels'
import {
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  snapshotPaths,
  snapshotPreview
} from '../domain/snapshots/snapshot'

/**
 * 插件配置快照的 IPC：手动/自动存、列、回退。
 *
 * 回退前会自动先存一份当前状态（见 snapshot.ts），所以回退本身也是可逆的。
 * 「存之前的预演」是弹窗里那两份列表（npm / 非 npm）。
 */
export function registerSnapshotsIpc(): void {
  ipcMain.handle(SNAPSHOT_CHANNELS.list, () => listSnapshots())
  ipcMain.handle(SNAPSHOT_CHANNELS.paths, () => snapshotPaths())
  ipcMain.handle(SNAPSHOT_CHANNELS.create, (_event: IpcMainInvokeEvent, label: string) =>
    createSnapshot('manual', typeof label === 'string' ? label : '')
  )
  ipcMain.handle(SNAPSHOT_CHANNELS.restore, (_event: IpcMainInvokeEvent, id: string) =>
    restoreSnapshot(id)
  )
  ipcMain.handle(SNAPSHOT_CHANNELS.remove, (_event: IpcMainInvokeEvent, id: string) =>
    deleteSnapshot(id)
  )
  ipcMain.handle(SNAPSHOT_CHANNELS.plan, () => snapshotPreview())
}
