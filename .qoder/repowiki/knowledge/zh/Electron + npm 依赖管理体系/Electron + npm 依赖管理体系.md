---
kind: dependency_management
name: Electron + npm 依赖管理体系
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - electron-builder.yml
    - electron.vite.config.ts
    - tsconfig.json
    - tsconfig.node.json
    - tsconfig.web.json
---

本仓库采用标准的 npm 生态进行依赖管理，以 package.json 为单一事实源，配合 package-lock.json 锁定版本，通过 electron-vite 构建编排与 electron-builder 打包分发。

1. 包管理器与锁定策略
- 使用 npm（根目录存在 package-lock.json），未启用 pnpm/yarn；未发现 .npmrc 或私有 registry 配置，仅保留 .npmrc.bak 备份文件。
- 所有第三方依赖均声明在 dependencies / devDependencies 中，无 peerDependencies、optionalDependencies 或 workspaces 多包结构。

2. 运行时 vs 开发时依赖划分
- 运行时依赖（仅 2 个）：@ffmpeg-installer/ffmpeg 提供 FFmpeg 二进制，fluent-ffmpeg 是 Node.js 侧调用 FFmpeg 的封装库。
- 开发时依赖：涵盖 Electron 33、electron-vite 2、Vite 5、React 18、Ant Design 5、TypeScript 5、Vitest 4、electron-builder 25 等，全部使用 ^ 语义化版本范围。

3. 构建期依赖外置（externalize）
- electron.vite.config.ts 对 main/preload 通道启用 externalizeDepsPlugin()，使主进程和预加载脚本直接引用 node_modules 中的模块而非被 Vite 打包进 asar，避免 C++ 原生模块无法正确加载的问题。
- renderer 通道使用 React 插件并配置 @/* 路径别名，不 externalize，由 Vite 正常打包。

4. 平台原生依赖处理
- postinstall 钩子执行 electron-builder install-app-deps，确保能根据当前 Electron 版本重新编译带原生 addon 的依赖。
- electron-builder.yml 显式将 resources/** 与 node_modules/@ffmpeg-installer/** 从 asar 中 unpack，保证 FFmpeg 二进制可被系统调用。
- Windows 目标使用 NSIS 安装包，产物命名模板 ${name}-${version}-setup.${ext}。

5. TypeScript 多项目引用
- 顶层 tsconfig.json 仅做引用聚合，实际分为 tsconfig.node.json（main/preload/config，moduleResolution=Node）与 tsconfig.web.json（renderer，moduleResolution=bundler，jsx=react-jsx，baseUrl+paths 定义 @/* 别名）。
- 两个 tsconfig 均开启 composite: true，支持增量编译。

6. 测试依赖
- Vitest 作为测试框架与运行器，测试用例位于 tests/，通过 npm test 执行。

开发者应遵循的规则
- 新增依赖时区分 runtime/devDependency，仅把真正在打包产物中使用的库放入 dependencies。
- 引入含原生模块的依赖后需确认是否需要 asarUnpack 或 externalizeDepsPlugin 处理。
- 不要手动编辑 package-lock.json，统一通过 npm i 变更。
- 如需私有 registry 或镜像，应在 .npmrc 中配置（目前仓库未启用）。