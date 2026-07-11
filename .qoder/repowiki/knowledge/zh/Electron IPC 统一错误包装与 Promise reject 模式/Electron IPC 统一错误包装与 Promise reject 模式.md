---
kind: error_handling
name: Electron IPC 统一错误包装与 Promise reject 模式
category: error_handling
scope:
    - '**'
source_files:
    - src/main/index.ts
    - src/preload/index.ts
    - src/main/ffmpeg.ts
    - src/renderer/src/App.tsx
---

## 1. 采用的错误处理体系

本项目采用「主进程返回结构化结果 + 预加载层自动解包为 Promise」的两段式错误处理模型，不依赖全局 try/catch、panic/recover（JS 无此概念）或中间件。

- 主进程：所有 ipcMain.handle 处理器使用 try/catch 捕获异常，并统一返回 { success, data?, message? } 结构体；业务函数通过 Promise.reject(new Error(...)) 抛出错误。
- 预加载层：invokeApi 在收到 success === false 时主动 throw new Error(result.message)，把主进程的「成功/失败」语义转换为标准的 JS Promise 失败路径。
- 渲染进程：调用 window.api.* 时使用 try/catch 或 .catch() 消费错误，无需关心主进程内部实现。

## 2. 关键文件与职责

- src/main/index.ts：全部 IPC 处理器入口，集中 try/catch → { success, message } 包装
- src/preload/index.ts：invokeApi 统一解包器，将 { success:false } 转为 throw Error
- src/main/ffmpeg.ts：底层 FFmpeg 操作，通过 reject(new Error(...)) 上报错误
- src/renderer/src/App.tsx：渲染侧示例：对配置加载等轻量调用做静默 catch

## 3. 架构约定与设计决策

### 3.1 主进程返回值契约
每个 IPC 通道必须返回如下对象之一：
- 成功：{ success: true, data?: any }
- 失败：{ success: false, message: string }
典型位置：scan:flvFiles、video:getInfo、video:merge、video:convert、dialog:* 等处理器均遵循该契约。批量合并 video:batchMerge 返回的每个任务项额外携带 error?: string 字段，用于区分部分失败。

### 3.2 预加载层的自动解包
invokeApi 是唯一的 IPC 出口：
- 若 result.success === false → throw new Error(result.message || '操作失败')
- 否则直接返回 result.data
这使得渲染进程可以以同步风格的 await api.xxx() 调用，错误自然走 Promise reject 分支。

### 3.3 业务函数的 Promise reject 模式
ffmpeg.ts 中的 mergeVideos、convertToMp4、getVideoInfo 全部通过 reject(new Error(msg)) 表达失败，由上层 IPC 处理器捕获后转为 { success:false }。错误信息包含具体原因（如「无法创建输出目录」「所有源文件都被占用」「合并超时（30分钟）」），便于用户理解。

### 3.4 进度与失败的协同
- 正常流程：主进程维护 mergeProgress / convertProgress / batchMergeProgress，渲染进程轮询 progress:get / progress:getBatch。
- 失败场景：批量合并中单个任务失败时，其进度置为 -1，并在结果数组中附带 error 字段，渲染进程据此显示单任务失败状态。

### 3.5 未覆盖的错误路径
- 预加载层 contextBridge.exposeInMainWorld 的 catch 仅 console.error，不会向上抛错。
- 渲染侧 App.tsx 对 loadConfig 的 catch 直接忽略，属于容错设计而非错误上报。

## 4. 开发者应遵循的规则

1. IPC 处理器一律返回 { success, data?, message? }，新增通道时在 try/catch 中包裹业务逻辑，失败时返回 { success:false, message }。
2. 业务函数使用 reject(new Error(msg)) 报告错误，不要在业务函数内自行打印日志后吞掉错误，让上层统一包装。
3. 错误消息面向用户可读，避免暴露堆栈或内部路径。
4. 批量任务单独记录 error 字段，并行执行时不要中断整体 Promise，而是为每个任务填充 error，由调用方决定展示策略。
5. 渲染侧对非关键调用可静默 catch，如对主题加载失败不应阻断 UI，但对核心操作（扫描、合并、转换）必须显式提示用户。
6. 不要绕过 invokeApi，渲染进程禁止直接 ipcRenderer.invoke，统一经 window.api 访问，以保证错误解包一致性。