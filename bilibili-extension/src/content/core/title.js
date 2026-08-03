// core/title.js - 标题解析纯函数（不依赖 DOM，可单测）

/** 从文件名提取核心标题（去掉日期与「合并版」后缀），用于页面定位等内部匹配 */
export function cleanTitle(fileName) {
  const name = fileName.replace(/\.mp4$/i, '')
  const title = name
    .replace(/^(?:\d{4}[-_]\d{2}[-_]\d{2})\s*[_\s]*/, '')  // 去前置日期（分隔符可选）
    .replace(/(?:\s*_*\s*合并版)+$/g, '')                   // 去合并版后缀（先剥，避免残留日期被后置规则漏掉）
    .replace(/(?:\s*_?\s*\d{4}[-_]\d{2}[-_]\d{2})$/, '')     // 去后置日期
    .trim()
  return title || name
}

/** 从文件名解析投稿标题：保留文件名中的日期（如有）并前置，不加时间 */
export function parseTitle(fileName) {
  const name = fileName.replace(/\.mp4$/i, '')
  const dateMatch = name.match(/(\d{4})[-_](\d{2})[-_](\d{2})/)
  const title = cleanTitle(fileName)
  // title === name 表示未提取出独立标题（如文件名就是「日期_合并版」），此时不拼重复日期
  if (dateMatch && title !== name) {
    return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} ${title}`
  }
  return title
}
