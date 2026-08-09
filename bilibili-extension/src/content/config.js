// config.js - 页面适配配置：B站改版时优先修改此文件
// 所有 CSS 选择器、按钮文案、文本关键词、等待超时集中在此，避免散落各处

export const SELECTORS = {
  // 标题输入框（主稿件标题）
  titlePrecise: [
    'input[placeholder*="输入标题"]',
    'textarea[placeholder*="输入标题"]',
    'input[placeholder*="填写标题"]',
    'textarea[placeholder*="填写标题"]',
    'input[placeholder*="作品标题"]',
    'textarea[placeholder*="作品标题"]',
  ],
  titleFallback: [
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
    '[class*="title"] input',
    '[class*="title"] textarea',
  ],
  titleAny: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', '[class*="title"] input'],
  // 可见范围组件（自定义 check-radio-v2）
  visibilityName: '.check-radio-v2-name',
  visibilityContainer: '.check-radio-v2-container',
  visibilityBox: '.check-radio-v2-box',
  // 创作声明下拉
  declarationSelect: '.el-select',
  declarationTrigger: '.el-select__wrapper, .el-input__inner',
  declarationFormItem: '.el-form-item, tr, [class*="row"], [class*="item"]',
  // 文件上传入口
  fileInputSelectors: [
    'input[type="file"][accept*="video"]',
    'input[type="file"][accept*="mp4"]',
    '.upload-area input[type="file"]',
    '[class*="upload"] input[type="file"]',
    '[class*="drop"] input[type="file"]',
    'input[type="file"]',
  ],
  bccUploadWrapper: '.bcc-upload-wrapper input[type="file"]',
  imageFileInput:
    'input[type="file"][accept*="image"], input[type="file"][accept*="jpg"], input[type="file"][accept*="png"]',
  // 下拉菜单项
  dropdownItems:
    '.el-select-dropdown__item, .el-dropdown-menu__item, [class*="dropdown"] [class*="item"], [class*="option"], li',
  // 二次确认弹窗
  messageBox: '.el-message-box',
  // 封面弹窗已知选择器（向后兼容旧版 B站 UI）
  coverDialogKnown: [
    '.el-dialog__wrapper:not([style*="display: none"])',
    '.el-dialog:not([style*="display: none"])',
    '[class*="coverMaker"]:not([style*="display: none"])',
    '[class*="cover-maker"]:not([style*="display: none"])',
    '[class*="coverDialog"]:not([style*="display: none"])',
    '[class*="cover-dialog"]:not([style*="display: none"])',
    '[class*="cover-modal"]:not([style*="display: none"])',
  ],
  // 预览图（封面上传完成信号）
  coverPreviewImgs: 'img[src^="blob:"], img[src^="http"], img[src^="data:"]',
}

export const BUTTON_LABELS = {
  submit: '立即投稿',
  addPart: ['添加分P', '+ 添加分P'],
  coverConfirm: ['完成', '确定', '应用', '保存'],
  coverEntry: ['添加封面', '添加主封面', '封面设置', '更换封面', '选择封面', '上传封面'],
  coverFallbackEntry: ['封面', '* 封面', '添加主封面', '添加封面'],
}

export const TEXT_KEYWORDS = {
  declarationTarget: '内容无需标注',
  declarationLabel: '创作声明',
  coverFeatures: ['上传封面', '拖拽图片', '更换封面', '封面制作', '封面编辑', '封面裁剪', '裁剪封面'],
  submitProgress: ['投稿中', '正在提交'],
}

export const TIMEOUTS = {
  waitForForm: 600000, // 首个视频表单加载（上传可能很慢）
  waitForFormEditor: 60000, // 分P编辑页表单加载
  titlePrecise: 5000, // 标题精确选择器匹配
  titleFallback: 10000, // 标题模糊选择器匹配
  coverDialogFirst: 15000, // 封面弹窗首次等待
  coverDialogRetry1: 12000, // 封面弹窗重试1
  coverDialogRetry2: 10000, // 封面弹窗重试2
  coverUploaded: 15000, // 封面上传完成等待
  coverGrace: 5000, // 封面上传超时宽限
  coverConfirmBtn: 6000, // 封面确认按钮出现
  coverConfirmEnabled: 10000, // 封面确认按钮可用
  frameCapture: 30000, // 视频截帧超时（大文件/页面短暂不可见需要更长时间）
  submitWait: 30000, // 立即投稿按钮可用等待
  submitVerify: 5000, // 投稿生效验证
  dialogGoneMaxTries: 20, // 封面弹窗关闭轮询次数
  dialogGoneInterval: 250, // 封面弹窗关闭轮询间隔(ms)
  afterFormLoad: 2000, // 表单加载后的稳定等待
  afterTitleSet: 300, // 标题填写后的校验等待
  afterPartClick: 2000, // 添加分P后等待
  afterCardAppear: 2000, // 视频卡片出现后等待
  clickDropdownDelay: 500, // 下拉点击后等待
  visibilitySettle: 500, // 可见范围点击后等待
}

export const STORAGE_KEYS = {
  visibility: 'bili_helper_visibility',
  errorReports: 'bili_helper_error_reports',
}

export const VIDEO_EXTENSIONS = ['.mp4', '.flv', '.mkv', '.avi', '.mov', '.webm']
