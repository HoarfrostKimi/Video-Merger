---
kind: configuration_system
name: Electron 桌面应用配置系统
category: configuration_system
scope:
    - '**'
source_files:
    - src/main/index.ts
    - src/preload/index.ts
    - src/renderer/src/App.tsx
    - electron.vite.config.ts
    - electron-builder.yml
    - package.json
---

## 1. 系统概览
本仓库采用「主进程本地 JSON 文件 + IPC 暴露」的轻量级配置方案，用于持久化用户偏好（输入/输出目录、并发数、自动打开行为等）。构建期另有 electron-vite 与 electron-builder 两套工程配置。

## 2. 关键文件与职责
- `src/main/index.ts`：定义 `AppConfig` 接口、`loadConfig/saveConfig/getConfigPath`，注册 `config:load` / `config:save` IPC 通道；开发模式下将 `userData` 重定向到项目内 `user-data` 目录。
- `src/preload/index.ts`：通过 `contextBridge` 向渲染进程暴露 `api.loadConfig` / `api.saveConfig`，统一调用 `ipcRenderer.invoke('config:*')`。
- `src/renderer/src/App.tsx`：在启动时调用 `window.api.loadConfig()` 恢复界面状态，并在设置变更时调用 `saveConfig` 持久化。
- `electron.vite.config.ts`：electron-vite 构建配置，定义 main / preload / renderer 入口与别名。
- `electron-builder.yml`：打包产物过滤、NSIS 安装器参数、可执行名等分发配置。
- `package.json`：`postinstall` 触发 `electron-builder install-app-deps`，`pack` 脚本驱动构建与打包。
- `user-data/config.json`：运行时生成的用户配置存储位置（开发模式位于项目根下）。

## 3. 架构与约定
- **存储格式**：单文件 JSON，键值对扁平结构，字段由 `AppConfig` 类型约束（如 `inputFolder`、`outputFolder`、`concurrency`、`maxIntervalHours`、`autoOpenWebsite`、`autoOpenFolder`、`hiddenFolderKeys`、`darkMode` 等）。
- **加载策略**：`loadConfig` 优先读取 `app.getPath('userData') + '/config.json'`；若不存在或解析失败则返回空对象 `{}`，保证首次运行无侵入。
- **保存策略**：`saveConfig` 先 `loadConfig` 合并旧值，再深拷贝覆盖传入字段后写回，避免丢失未显式更新的字段。
- **访问边界**：渲染进程不直接读写磁盘，全部通过 `preload` 暴露的 `api.loadConfig` / `api.saveConfig` 走 IPC，遵循 Electron 安全最佳实践。
- **开发/生产路径差异**：`is.dev` 分支中 `app.setPath('userData', join(__dirname, '../../user-data'))`，使调试期间配置文件落在仓库内，便于查看与清理。
- **构建期配置隔离**：`electron.vite.config.ts` 仅参与编译期产物组织；`electron-builder.yml` 控制安装包结构与 NSIS 行为，两者均不参与运行时配置加载。

## 4. 开发者应遵守的规则
- 新增配置项必须在 `AppConfig` 接口中声明，并在 `saveConfig` 调用处提供默认值或迁移逻辑，避免破坏向后兼容。
- 所有配置读写必须经过 `api.loadConfig` / `api.saveConfig`，禁止在渲染进程直接操作文件系统。
- 修改 `userData` 路径前需确认是否处于 `is.dev` 分支，以免在生产环境误改系统目录。
- 如需引入外部配置源（环境变量、远程配置），应在 `loadConfig` 入口处做合并层，保持现有 JSON 文件作为最终权威来源不变。
- 构建相关变量（如 `ELECTRON_RENDERER_URL`）仅在 `createWindow` 中用于开发热重载，不应混入运行时配置。