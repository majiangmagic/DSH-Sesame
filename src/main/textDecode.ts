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
 */
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const gbkDecoder = new TextDecoder('gbk')

export function decodeChunk(chunk: Buffer): string {
  try {
    return utf8Decoder.decode(chunk, { stream: true })
  } catch {
    return gbkDecoder.decode(chunk)
  }
}
