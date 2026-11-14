const res = await fetch('https://awesome-dsh-plugin.com/plugins.json')
const raw = await res.json()
const list = raw.plugins ?? raw
console.log('条目数:', list.length)
// 复现 filtered：query='' category='' onlyInstalled=false
const needle = ''
const picked = ''
const filtered = list.filter((plugin) => {
  if (false && plugin) return false          // onlyInstalled=false
  if (picked !== '' && !(plugin.category ?? []).includes(picked)) return false
  if (needle === '') return true
  return true
})
console.log('filtered:', filtered.length)
console.log('前 3 条 name:', filtered.slice(0,3).map(p => p.name))
// 检查字段
const first = list[0]
console.log('字段:', Object.keys(first).join(','))
console.log('category 样例:', JSON.stringify(first.category))
