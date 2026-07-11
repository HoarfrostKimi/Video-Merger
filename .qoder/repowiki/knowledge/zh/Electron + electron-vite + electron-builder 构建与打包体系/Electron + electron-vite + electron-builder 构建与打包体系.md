---
kind: build_system
name: Electron + electron-vite + electron-builder 构建与打包体系
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - electron.vite.config.ts
    - electron-builder.yml
    - tsconfig.json
    - tsconfig.node.json
    - tsconfig.web.json
    - build.sh
    - build.bat
---

本项目采用「electron-vite 统一编排 + electron-builder 分发」的构建流水线，将 Electron 主进程、预加载脚本与 React 渲染进程统一编译并产出 Windows NSIS 安装包。

## 1. 构建工具链与角色分工
- **electron-vite**：作为核心编排器，通过 `electron.vite.config.ts` 同时管理 main / preload / renderer 三个入口的 Vite 构建；对 main 和 preload 使用 `externalizeDepsPlugin()` 避免把 node_modules 打入 bundle，renderer 启用 `@vitejs/plugin-react` 支持 JSX。
- **TypeScript 多项目引用**：根 `tsconfig.json` 仅声明 references，拆分为 `tsconfig.node.json`（main/preload/配置）与 `tsconfig.web.json`（renderer/src），分别对应 Node 与浏览器模块解析策略，并通过 `composite: true` 开启增量编译。
- **electron-builder**：负责产物打包与分发，输出 NSIS 安装器；`electron-builder.yml` 中通过 `files` 白名单排除源码与配置文件，`asarUnpack` 保留 `node_modules/@ffmpeg-installer/**` 以便运行时调用 ffmpeg。
- **测试**：基于 Vitest（`vitest run`），与构建解耦，位于 `tests/` 目录。

## 2. 关键文件与职责
- `package.json`：定义 `dev/build/preview/pack/dist/test` 等 npm scripts，其中 `postinstall` 自动执行 `electron-builder install-app-deps` 以修复原生依赖。
- `electron.vite.config.ts`：三端构建配置，包含 alias `@ -> src/renderer/src`。
- `electron-builder.yml`：应用 ID、产品名称、NSIS 行为（非一键安装、允许选择安装目录）、产物命名 `${name}-${version}-setup.${ext}`。
- `build.sh` / `build.bat`：跨平台一键打包壳脚本，封装 `npm run dist` 并打印耗时、打开 dist 目录。
- `tsconfig.{node,web}.json`：Node/Web 双 TS 配置，分别控制 moduleResolution、types、include 范围。

## 3. 构建流程与约定
开发：npm run dev → electron-vite dev 启动热重载
预览：npm run preview → 预览已构建产物
打包：npm run build → electron-vite build 产出 out/main | out/preload | out/renderer
分发：npm run dist → 先 build，再 electron-builder 生成 dist/video-merger-1.0.0-setup.exe

版本号来自 `package.json` 的 `version`，electron-builder 直接复用，无需额外版本注入。
产物目录固定为 `out/`（TS outDir）与 `dist/`（electron-builder 输出）。
FFmpeg 通过 `@ffmpeg-installer/ffmpeg` 在运行时安装，且被 `asarUnpack` 显式排除出 asar，保证可执行。

## 4. 开发者应遵循的规则
- 新增主进程/预加载逻辑时，确保其依赖是纯 JS/TS 或可通过 `externalizeDepsPlugin` 外部化，不要手动打包进 bundle。
- 新增资源文件需同步更新 `electron-builder.yml` 的 `files` 白名单，否则不会进入安装包。
- 需要让运行时直接访问的文件（如 ffmpeg、自定义 resources）必须加入 `asarUnpack`。
- 修改 TypeScript 路径别名时，需同时维护 `electron.vite.config.ts` 与 `tsconfig.web.json` 中的 `paths`，保持一致。
- 跨平台打包请使用 `build.sh`（Linux/macOS）或 `build.bat`（Windows），避免绕过 `npm run dist` 导致依赖缺失。
- 当前仅配置了 Windows (nsis) target，若需 macOS/Linux 分发，需在 `electron-builder.yml` 补充对应 platform 配置。