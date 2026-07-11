---
kind: frontend_style
name: 基于 Ant Design 5 的桌面端 UI 风格体系
category: frontend_style
scope:
    - '**'
source_files:
    - src/renderer/src/assets/styles/global.css
    - src/renderer/src/pages/Home.tsx
    - package.json
---

## 样式系统与框架选型
- 组件库：Ant Design 5（`antd@^5.22.0`）+ `@ant-design/icons@^5.5.1`，作为唯一 UI 组件来源。
- 构建与渲染：Electron + React 18 + Vite（通过 `electron-vite` 编排），渲染进程入口为 `src/renderer/src/main.tsx`，页面集中在 `src/renderer/src/pages/`。
- CSS 方案：全局样式仅维护一份 `src/renderer/src/assets/styles/global.css`，采用最基础的 reset + 系统字体栈 + 浅色背景；业务样式全部以内联 style 对象或 Antd 组件内置主题属性完成，未引入 SCSS、CSS Modules、Tailwind 等额外样式工具链。
- 主题策略：通过 props 透传 `darkMode` 在 Header 等局部区域切换明暗色（如 `background: darkMode ? '#141414' : '#fff'`），属于轻量级“开关式”深色模式，尚未使用 Antd ConfigProvider 的全局 theme 配置。

## 关键文件与包
- 全局样式入口：`src/renderer/src/assets/styles/global.css`
- 主页面（承载绝大部分 UI 结构）：`src/renderer/src/pages/Home.tsx`
- 依赖声明（含 antd、@ant-design/icons、dayjs、zustand 等）：`package.json`
- Electron 打包配置（影响资源输出，间接关联前端产物）：`electron-builder.yml`、`electron.vite.config.ts`

## 架构与约定
- 单页布局：以 `<Layout>` + `<Header>` + `<Content>` 构成应用骨架，页面内再按功能拆分为多个 `<Card>` 区块（输入目录、输出目录、待合并列表、子文件详情、进度区、设置 Drawer）。
- 状态驱动视图：UI 状态由 React useState/useRef 管理，并通过 Antd 的 Table、Progress、Tag、Space、Button、Input、Switch、Drawer、Typography 等组件组合呈现；无独立样式文件或 CSS-in-JS 库。
- 图标与文案：统一使用 `@ant-design/icons` 提供的 SVG 图标（如 `FolderOpenOutlined`、`ScanOutlined`、`MergeCellsOutlined` 等），中文文案直接硬编码在 JSX 中。
- 响应式与尺寸：主要依赖 Antd 组件的内置响应行为（如 Space wrap、Table scroll.y），未定义自定义断点或媒体查询。
- 设计令牌：当前仓库未提取颜色、字号、间距等 design tokens，所有视觉值以字面量形式散布在组件内联 style 与 Antd 属性中。

## 开发者应遵循的规则
1. **优先使用 Antd 5 组件**：新增界面元素应通过 `antd` 组件组合实现，避免手写 DOM 结构替代现有组件。
2. **禁止新增全局 CSS**：如需覆盖默认样式，尽量通过 Antd 组件属性或局部 style 对象；确需新增规则时，集中写入 `src/renderer/src/assets/styles/global.css` 并控制范围。
3. **深色模式扩展**：若需要更完善的主题支持，建议迁移到 `ConfigProvider` 的 theme 配置，将明暗色值从硬编码抽取为 token，保持与现有 `darkMode` prop 语义一致。
4. **图标与文案规范**：图标统一来自 `@ant-design/icons`；中文文案暂不抽离 i18n，但应保持命名清晰、可搜索。
5. **布局与间距**：沿用 `Space` + `Card` 的组合模式，保持卡片间间距与内部 padding 的一致性，避免随意写死 margin/padding。