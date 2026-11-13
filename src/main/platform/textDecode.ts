/**
 * 子进程输出的解码。
 *
 * Windows 上 Python 子进程（MCP 服务等）默认按**控制台代码页**写输出 —— 中文环境是 GBK。
 * 之前一律 `toString('utf8')`，于是它们的中文报错全变成乱码（实测：
 * Blender MCP 的「由于目标计算机积极拒绝，无法连接。」显示成 `����Ŀ��…`）。
 *
 * 先用 UTF-8（`stream: true` 能容忍跨块的半个字符 —— 子进程输出是按块到达的），
 * 解不通再按 GBK 解。runner / pluginInstall 另会给子进程设 PYTHONIOENCODING 与
 * PYTHONUTF8，让 Python 直接输出 UTF-8；这里是兜底，覆盖非 Python 的子进程。
 *
 * ⚠️ 之前这里是**模块级单例**，stdout 与 stderr 共用同一个 decoder，
 * 两个流的半个字符会互相污染；且 `stream: true` 的残留状态必须按流持有。
 * 现在每次调用都新建 —— TextDecoder 构造开销可忽略，换来跨流/跨进程不串扰。
 */

export interface StreamDecoder {
  decode(chunk: Buffer): string
}

/** 每路输出各自持有一个解码器 —— `stream: true` 的残留状态绝不能共享。 */
export function createStreamDecoder(): StreamDecoder {
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const gbk = new TextDecoder('gbk')
  return {
    decode(chunk: Buffer): string {
      try {
        return utf8.decode(chunk, { stream: true })
      } catch {
        return gbk.decode(chunk)
      }
    }
  }
}

/** 兼容旧调用点；新代码请用 `createStreamDecoder()` 为**每一路输出**各建一个。 */
export function decodeChunk(chunk: Buffer): string {
  return createStreamDecoder().decode(chunk)
}
