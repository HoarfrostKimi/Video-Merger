// esbuild.config.mjs - B站投稿助手构建脚本
// 把 src/content/ 多模块打包成单文件 dist/content.js（MV3 content script 要求单文件）
import { build, context } from 'esbuild'

const isWatch = process.argv.includes('--watch')

const options = {
  entryPoints: ['src/content/index.js'],
  bundle: true,
  outfile: 'dist/content.js',
  format: 'iife',
  target: ['chrome110'],
  // 保持 UTF-8 中文直出：函数 toString() 输出的源码保持可读（错误自证依赖），
  // 也避免 ASCII 转义导致日志/错误包里的中文变 \uXXXX
  charset: 'utf8',
  // 不压缩：保持函数 toString() 输出可读源码，错误自证功能依赖此行为
  minify: false,
  legalComments: 'none',
  banner: {
    js: '// content.js - B站投稿助手（由 src/ 构建生成，请勿直接修改本文件）',
  },
}

if (isWatch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('[build] watch 模式运行中，修改 src/ 后自动重新构建...')
} else {
  await build(options)
  console.log('[build] 构建完成 → dist/content.js')
}
