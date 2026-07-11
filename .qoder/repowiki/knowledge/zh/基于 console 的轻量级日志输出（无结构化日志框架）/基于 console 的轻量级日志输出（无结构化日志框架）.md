---
kind: logging_system
name: 基于 console 的轻量级日志输出（无结构化日志框架）
category: logging_system
scope:
    - '**'
source_files:
    - src/main/index.ts
    - src/main/ffmpeg.ts
    - src/preload/index.ts
    - src/renderer/src/pages/Home.tsx
---

本仓库未引入任何第三方日志框架，也未建立统一的日志模块或日志级别体系。应用在各层直接调用 Node.js 原生 `console.log` / `console.error` / `console.warn` 进行调试与诊断输出，属于最轻量的“控制台直写”模式。

- 主进程 (`src/main/index.ts`)：在配置加载/保存、IPC 处理等关键路径使用带前缀的 `console.log('[loadConfig] ...')`、`console.error('[loadConfig] 失败:', e)` 记录流程与异常。
- FFmpeg 封装 (`src/main/ffmpeg.ts`)：对合并/转换命令、进度百分比、跳过文件警告、错误退出码等场景打印 `console.log` / `console.error`，便于通过 Electron 开发者工具或终端排查。
- 预加载脚本 (`src/preload/index.ts`)：在 `contextBridge.exposeInMainWorld` 捕获异常时 `console.error(error)`。
- 渲染进程 (`src/renderer/src/pages/Home.tsx`)：在配置加载失败、批量进度轮询失败等分支使用 `console.warn` 提示。

当前架构评审文档中已明确标注「2.1 日志记录（低优先级）仅 console.log，无日志文件/面板」，说明该方式仅为 MVP 阶段的临时方案，尚未规划结构化日志、分级策略、持久化到文件或用户可见日志面板等能力。

依赖方面，`package-lock.json` 中出现大量间接依赖的 `debug` 包（来自 electron-builder、electron-vite 等），但业务代码并未直接使用它作为日志库。

**开发者应遵循的规则（现状）**
- 如需新增日志，可直接使用 `console.log` / `console.error` / `console.warn`；建议沿用 `[模块名] 前缀` 风格以便过滤。
- 暂不引入新的日志框架或写入磁盘日志文件；后续若需升级，应在独立 logger 模块中集中管理，并统一 log level、sink 与字段结构。