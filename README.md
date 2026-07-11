# Video Merger · 视频合并工具

一款基于 **Electron** 的桌面应用，专为**直播录制用户**设计。自动扫描 FLV 分段文件，智能分组后一键合并为完整的 MP4 视频。

![Electron](https://img.shields.io/badge/Electron-33-blue) ![React](https://img.shields.io/badge/React-18-61dafb) ![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6) ![License](https://img.shields.io/badge/License-MIT-green)

---

## 📖 简介

你是否遇到过这样的情况——用录播姬、BililiveRecorder 等软件录制直播，得到的是一堆几分钟到几十分钟的 FLV 分段文件？视频合并工具就是来解决这个问题的：**自动识别、智能分组、一键合并**，把散落的分段文件合并成一个完整的 MP4 视频。

> 也支持 M4S、TS、BLV 等格式的分段文件。

---

## ✨ 功能一览

### 核心功能

| 功能 | 说明 |
|------|------|
| **📂 文件夹扫描** | 选择文件夹后自动扫描所有视频文件，支持递归子目录 |
| **🧩 智能分组** | 按文件名中的日期+标题自动归组，识别同一场直播的不同分段 |
| **🔄 视频合并** | 将同组的分段文件按顺序合并为一个完整的 MP4 |
| **⚡ 批量并行合并** | 支持多个分组同时合并，可调节并发数（上限 4） |
| **🎞️ 不压缩模式** | 使用 FFmpeg stream copy，快速合并无需重新编码，保留原画质 |
| **🎨 深色/浅色主题** | 自由切换，护眼舒适 |

### 特色功能

| 功能 | 说明 |
|------|------|
| **🚫 排除/恢复分组** | 可临时隐藏不需要的分组，状态自动保存，下次启动依然有效 |
| **📱 手机端控制面板** | 同一局域网内，手机浏览器可远程查看和控制合并任务（需设置控制密码） |
| **📤 B 站投稿助手** | 配合 Chrome 扩展，合并后一键投稿到哔哩哔哩 |
| **📁 自动打开输出文件夹** | 合并完成后自动弹出输出目录，方便找到文件 |
| **🎛️ 灵活的设置面板** | 输出目录、合并间隔阈值、并发数、后台运行等均可自由配置 |

---

## 🖼️ 界面预览

> 界面基于 Ant Design 5 构建，简洁现代，操作直观。

---

## 🚀 快速开始

### 从源码运行

```bash
# 1. 克隆项目
git clone https://github.com/HoarfrostKimi/Video-Merger.git
cd Video-Merger

# 2. 安装依赖
npm install

# 3. 启动开发模式
npm run dev
```

### 一键打包

**Windows：**
```bash
build.bat
```

**macOS / Linux：**
```bash
chmod +x build.sh
./build.sh
```

打包后的安装包位于 `dist/` 目录。

### NPM 命令速查

| 命令 | 作用 |
|------|------|
| `npm run dev` | 启动开发模式（热更新） |
| `npm run build` | 仅构建前端 + 主进程 |
| `npm run preview` | 预览构建产物 |
| `npm run pack` | 构建 + 打包为目录（免安装） |
| `npm run dist` | 构建 + 打包为安装程序（.exe） |
| `npm test` | 运行单元测试 |

---

## 🛠️ 技术栈

| 层级 | 技术选型 |
|------|---------|
| **桌面框架** | Electron 33 |
| **前端框架** | React 18 + TypeScript 5 |
| **构建工具** | Vite 5 + electron-vite |
| **UI 组件库** | Ant Design 5 + @ant-design/icons |
| **状态管理** | Zustand 5 |
| **视频处理** | FFmpeg（内嵌，用户无需安装） |
| **FFmpeg 集成** | @ffmpeg-installer/ffmpeg + fluent-ffmpeg |
| **打包工具** | electron-builder 25（NSIS 安装包） |
| **单元测试** | Vitest |

---

## 📋 系统要求

- **操作系统**：Windows 10 / 11（推荐）
- **磁盘空间**：至少 500MB（含内置 Chromium 和 FFmpeg）
- **内存**：建议 4GB 以上

> 项目主要面向 Windows 用户，macOS / Linux 可自行构建。

---

## 🔧 配置说明

配置文件保存在用户数据目录（开发模式为 `user-data/config.json`），包含：

- `inputFolder` / `outputFolder` — 输入/输出目录
- `maxIntervalHours` — 合并时间间隔阈值（默认 2.5 小时）
- `concurrency` — 并行合并数（默认 3，上限 4）
- `darkMode` — 深色模式开关
- `autoOpenFolder` — 合并完成后自动打开目录
- `controlEnabled` / `controlPort` / `controlPassword` — 手机控制面板设置
- `hiddenFolderKeys` — 被排除的分组
- `runInBackground` — 后台运行（最小化到系统托盘）

---

## 🧪 运行测试

```bash
npm test
```

测试覆盖：文件名解析、视频分组、FFmpeg 参数生成、配置管理、已合并文件缓存等核心逻辑。

---

## 📄 许可证

本项目基于 **MIT** 许可证开源。

---

## 🙏 致谢

- [FFmpeg](https://ffmpeg.org/) — 强大的音视频处理工具
- [Electron](https://www.electronjs.org/) — 跨平台桌面应用框架
- [Ant Design](https://ant.design/) — 优秀的 UI 组件库
- [BililiveRecorder](https://github.com/BililiveRecorder/BililiveRecorder) — 直播录制工具
