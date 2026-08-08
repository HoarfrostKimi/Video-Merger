// content.js - B站投稿助手（由 src/ 构建生成，请勿直接修改本文件）
(() => {
  // src/content/core/wait.js
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async function waitFor(condition, timeout = 8e3, interval = 300) {
    const start = Date.now();
    for (; ; ) {
      const res = condition();
      if (res) return res;
      if (Date.now() - start >= timeout) return null;
      await sleep(interval);
    }
  }
  function waitForElement(selectors, timeout = 3e4) {
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];
    return new Promise((resolve, reject) => {
      for (const sel of selectorList) {
        const el = document.querySelector(sel);
        if (el) return resolve(el);
      }
      const observer = new MutationObserver(() => {
        for (const sel of selectorList) {
          const el = document.querySelector(sel);
          if (el) {
            observer.disconnect();
            return resolve(el);
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待元素超时`));
      }, timeout);
    });
  }
  function waitForElementByText(keyword, timeout = 6e4) {
    const check = () => {
      for (const el of document.querySelectorAll("*")) {
        const text = el.textContent || "";
        if (text.includes(keyword) && text.length < 200) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 100 && rect.height > 30) return el;
        }
      }
      return null;
    };
    const existing = check();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const obs = new MutationObserver(() => {
        const el = check();
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        reject(new Error(`等待「${keyword}」超时`));
      }, timeout);
    });
  }

  // src/content/config.js
  var SELECTORS = {
    // 标题输入框（主稿件标题）
    titlePrecise: [
      'input[placeholder*="输入标题"]',
      'textarea[placeholder*="输入标题"]',
      'input[placeholder*="填写标题"]',
      'textarea[placeholder*="填写标题"]',
      'input[placeholder*="作品标题"]',
      'textarea[placeholder*="作品标题"]'
    ],
    titleFallback: [
      'input[placeholder*="标题"]',
      'textarea[placeholder*="标题"]',
      '[class*="title"] input',
      '[class*="title"] textarea'
    ],
    titleAny: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', '[class*="title"] input'],
    // 可见范围组件（自定义 check-radio-v2）
    visibilityName: ".check-radio-v2-name",
    visibilityContainer: ".check-radio-v2-container",
    visibilityBox: ".check-radio-v2-box",
    // 创作声明下拉
    declarationSelect: ".el-select",
    declarationTrigger: ".el-select__wrapper, .el-input__inner",
    declarationFormItem: '.el-form-item, tr, [class*="row"], [class*="item"]',
    // 文件上传入口
    fileInputSelectors: [
      'input[type="file"][accept*="video"]',
      'input[type="file"][accept*="mp4"]',
      '.upload-area input[type="file"]',
      '[class*="upload"] input[type="file"]',
      '[class*="drop"] input[type="file"]',
      'input[type="file"]'
    ],
    bccUploadWrapper: '.bcc-upload-wrapper input[type="file"]',
    imageFileInput: 'input[type="file"][accept*="image"], input[type="file"][accept*="jpg"], input[type="file"][accept*="png"]',
    // 下拉菜单项
    dropdownItems: '.el-select-dropdown__item, .el-dropdown-menu__item, [class*="dropdown"] [class*="item"], [class*="option"], li',
    // 二次确认弹窗
    messageBox: ".el-message-box",
    // 封面弹窗已知选择器（向后兼容旧版 B站 UI）
    coverDialogKnown: [
      '.el-dialog__wrapper:not([style*="display: none"])',
      '.el-dialog:not([style*="display: none"])',
      '[class*="coverMaker"]:not([style*="display: none"])',
      '[class*="cover-maker"]:not([style*="display: none"])',
      '[class*="coverDialog"]:not([style*="display: none"])',
      '[class*="cover-dialog"]:not([style*="display: none"])',
      '[class*="cover-modal"]:not([style*="display: none"])'
    ],
    // 预览图（封面上传完成信号）
    coverPreviewImgs: 'img[src^="blob:"], img[src^="http"], img[src^="data:"]'
  };
  var BUTTON_LABELS = {
    submit: "立即投稿",
    addPart: ["添加分P", "+ 添加分P"],
    coverConfirm: ["完成", "确定", "应用", "保存"],
    coverEntry: ["添加封面", "添加主封面", "封面设置", "更换封面", "选择封面", "上传封面"],
    coverFallbackEntry: ["封面", "* 封面", "添加主封面", "添加封面"]
  };
  var TEXT_KEYWORDS = {
    declarationTarget: "内容无需标注",
    declarationLabel: "创作声明",
    coverFeatures: ["上传封面", "拖拽图片", "更换封面", "封面制作", "封面编辑", "封面裁剪", "裁剪封面"],
    submitProgress: ["投稿中", "正在提交"]
  };
  var TIMEOUTS = {
    waitForForm: 6e5,
    // 首个视频表单加载（上传可能很慢）
    waitForFormEditor: 6e4,
    // 分P编辑页表单加载
    titlePrecise: 5e3,
    // 标题精确选择器匹配
    titleFallback: 1e4,
    // 标题模糊选择器匹配
    coverDialogFirst: 15e3,
    // 封面弹窗首次等待
    coverDialogRetry1: 12e3,
    // 封面弹窗重试1
    coverDialogRetry2: 1e4,
    // 封面弹窗重试2
    coverUploaded: 15e3,
    // 封面上传完成等待
    coverGrace: 5e3,
    // 封面上传超时宽限
    coverConfirmBtn: 6e3,
    // 封面确认按钮出现
    coverConfirmEnabled: 1e4,
    // 封面确认按钮可用
    frameCapture: 15e3,
    // 视频截帧超时
    submitWait: 3e4,
    // 立即投稿按钮可用等待
    submitVerify: 5e3,
    // 投稿生效验证
    dialogGoneMaxTries: 20,
    // 封面弹窗关闭轮询次数
    dialogGoneInterval: 250,
    // 封面弹窗关闭轮询间隔(ms)
    afterFormLoad: 2e3,
    // 表单加载后的稳定等待
    afterTitleSet: 300,
    // 标题填写后的校验等待
    afterPartClick: 2e3,
    // 添加分P后等待
    afterCardAppear: 2e3,
    // 视频卡片出现后等待
    clickDropdownDelay: 500,
    // 下拉点击后等待
    visibilitySettle: 500
    // 可见范围点击后等待
  };
  var STORAGE_KEYS = {
    visibility: "bili_helper_visibility",
    errorReports: "bili_helper_error_reports"
  };
  var VIDEO_EXTENSIONS = [".mp4", ".flv", ".mkv", ".avi", ".mov", ".webm"];

  // src/content/core/find.js
  function findFileInput() {
    for (const sel of SELECTORS.fileInputSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        console.log("[B站投稿助手] 找到 file input:", sel);
        return el;
      }
    }
    return null;
  }
  function findButtonByText(text) {
    const all = document.querySelectorAll("*");
    let bestMatch = null;
    for (const el of all) {
      const directText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      if (directText === text) {
        if (!bestMatch || el.childNodes.length < bestMatch.childNodes.length) {
          bestMatch = el;
        }
      }
    }
    return bestMatch ? toClickable(bestMatch) : null;
  }
  function findButtonInScope(text, scope) {
    const all = scope.querySelectorAll("*");
    let bestMatch = null;
    for (const el of all) {
      const directText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      if (directText === text) {
        if (!bestMatch || el.childNodes.length < bestMatch.childNodes.length) {
          bestMatch = el;
        }
      }
    }
    return bestMatch ? toClickable(bestMatch) : null;
  }
  function toClickable(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const tag = cur.tagName.toLowerCase();
      if (tag === "button" || tag === "a" || cur.getAttribute("role") === "button") {
        return cur;
      }
      const cls = cur.className || "";
      if (typeof cls === "string" && (cls.includes("btn") || cls.includes("button") || cls.includes("link") || cls.includes("cover"))) {
        return cur;
      }
      const style = window.getComputedStyle(cur);
      if (style.cursor === "pointer") {
        return cur;
      }
      cur = cur.parentElement;
    }
    return el;
  }
  function clickDropdownOption(text) {
    const items = document.querySelectorAll(SELECTORS.dropdownItems);
    for (const item of items) {
      if (item.textContent.trim() === text || item.textContent.trim().includes(text)) {
        const rect = item.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          item.click();
          return true;
        }
      }
    }
    return false;
  }
  function findCoverDialog() {
    const known = document.querySelector(SELECTORS.coverDialogKnown.join(", "));
    if (known) return known;
    const candidates = [];
    const imgInputs = document.querySelectorAll(SELECTORS.imageFileInput);
    for (const inp of imgInputs) {
      if (inp.offsetParent !== null || inp.closest('[style*="display: none"]') === null) {
        candidates.push(inp);
      }
    }
    if (candidates.length === 0) {
      const allEls = document.querySelectorAll("div, section, aside");
      for (const el of allEls) {
        const text = el.textContent || "";
        if (text.length < 500 && (TEXT_KEYWORDS.coverFeatures.some((kw) => text.includes(kw)) || text.includes("封面") && text.includes("裁剪"))) {
          candidates.push(el);
        }
      }
    }
    if (candidates.length === 0) {
      const canvases = document.querySelectorAll("canvas");
      for (const cvs of canvases) {
        const style = window.getComputedStyle(cvs);
        if (style.display !== "none" && cvs.width > 100 && cvs.height > 100) {
          candidates.push(cvs);
        }
      }
    }
    for (const el of candidates) {
      let node = el;
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        const cls = (node.className || "").toString().toLowerCase();
        const zIndex = parseInt(style.zIndex) || 0;
        const isOverlay = style.position === "fixed" || style.position === "absolute" || cls.includes("dialog") || cls.includes("modal") || cls.includes("overlay") || cls.includes("popup") || cls.includes("drawer") || cls.includes("mask") || cls.includes("crop") || cls.includes("cover") || node.getAttribute("role") === "dialog" || node.getAttribute("role") === "alertdialog" || zIndex > 50;
        if (isOverlay && style.display !== "none" && style.visibility !== "hidden") {
          return node;
        }
        node = node.parentElement;
      }
    }
    const allContainers = document.querySelectorAll("div, section, aside, article");
    for (const ov of allContainers) {
      const style = window.getComputedStyle(ov);
      if (style.position !== "fixed" && style.position !== "absolute") continue;
      if (style.display === "none" || style.visibility === "hidden") continue;
      const zIndex = parseInt(style.zIndex) || 0;
      if (zIndex < 50) continue;
      const text = ov.textContent || "";
      if (text.includes("封面") || text.includes("裁剪") || ov.querySelector('input[type="file"], canvas, img[src^="blob:"]')) {
        return ov;
      }
    }
    return null;
  }

  // src/content/core/title.js
  function cleanTitle(fileName) {
    const name = fileName.replace(/\.mp4$/i, "");
    const title = name.replace(/^(?:\d{4}[-_]\d{2}[-_]\d{2})\s*[_\s]*/, "").replace(/(?:\s*_*\s*合并版)+$/g, "").replace(/(?:\s*_?\s*\d{4}[-_]\d{2}[-_]\d{2})$/, "").trim();
    return title || name;
  }
  function parseTitle(fileName) {
    const name = fileName.replace(/\.mp4$/i, "");
    const dateMatch = name.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
    const title = cleanTitle(fileName);
    if (dateMatch && title !== name) {
      return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} ${title}`;
    }
    return title;
  }

  // src/content/core/errorReport.js
  var logBuffer = [];
  var MAX_LOG_BUFFER = 300;
  var currentStep = null;
  var isUploading = false;
  function setCurrentStep(step) {
    currentStep = step;
  }
  function setIsUploading(v) {
    isUploading = v;
  }
  async function runStep(name, fn, ...args) {
    currentStep = { name, source: fn.toString() };
    return fn(...args);
  }
  function collectDomSnapshot() {
    const snap = {};
    const grab = (key, selectors) => {
      try {
        const el = document.querySelector(selectors);
        snap[key] = el ? el.outerHTML.slice(0, 600) : null;
      } catch (e) {
        snap[key] = null;
      }
    };
    grab("标题框", SELECTORS.titleAny.join(", "));
    grab("可见范围radio", SELECTORS.visibilityContainer);
    grab("创作声明select", SELECTORS.declarationSelect);
    grab("上传file input", 'input[type="file"]');
    const coverDialog = findCoverDialog();
    snap["封面弹窗"] = coverDialog ? coverDialog.outerHTML.slice(0, 800) : null;
    const submitBtn = findButtonByText("立即投稿");
    snap["立即投稿按钮"] = submitBtn ? submitBtn.outerHTML.slice(0, 300) : null;
    return snap;
  }
  function recordError(err, extra) {
    let dom = {};
    try {
      dom = collectDomSnapshot();
    } catch (e) {
      dom = { _error: String(e) };
    }
    const report = {
      time: (/* @__PURE__ */ new Date()).toLocaleString(),
      url: location.href,
      step: currentStep ? currentStep.name : "unknown",
      error: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack.split("\n").slice(0, 5).join("\n") : "",
      logTail: logBuffer.slice(-40),
      dom,
      source: currentStep ? currentStep.source.slice(0, 4e3) : "",
      extra: extra || {}
    };
    try {
      const key = STORAGE_KEYS.errorReports;
      const list = JSON.parse(localStorage.getItem(key) || "[]");
      if (!Array.isArray(list)) throw new Error("bad data");
      list.push(report);
      while (list.length > 5) list.shift();
      localStorage.setItem(key, JSON.stringify(list));
    } catch (e) {
      console.log("[B站投稿助手] 保存错误报告失败:", e);
    }
    return report;
  }
  function formatReportMarkdown(report) {
    const lines = [];
    lines.push("# B站投稿助手 · 错误报告");
    lines.push("");
    lines.push("## 基本信息");
    lines.push(`- 时间: ${report.time}`);
    lines.push(`- 页面: ${report.url}`);
    lines.push(`- 出错步骤: ${report.step}`);
    lines.push(`- 错误: ${report.error}`);
    if (report.stack) {
      lines.push("");
      lines.push("## 调用栈（前5行）");
      lines.push("```");
      lines.push(report.stack);
      lines.push("```");
    }
    if (Object.keys(report.extra || {}).length) {
      lines.push("");
      lines.push("## 附加上下文");
      for (const [k, v] of Object.entries(report.extra)) {
        lines.push(`- ${k}: ${v}`);
      }
    }
    lines.push("");
    lines.push("## 日志（尾部40条）");
    lines.push("```");
    lines.push((report.logTail || []).join("\n") || "(无日志)");
    lines.push("```");
    lines.push("");
    lines.push("## 出错瞬间 DOM 快照（选择器定位用）");
    for (const [key, html] of Object.entries(report.dom || {})) {
      lines.push(`### ${key}`);
      lines.push(html ? "```html\n" + html + "\n```" : "`(未找到)`");
    }
    lines.push("");
    lines.push("## 出错步骤源码");
    lines.push("```js");
    lines.push(report.source || "(无)");
    lines.push("```");
    return lines.join("\n");
  }

  // src/content/steps/upload.js
  async function stepUploadFile(file, onLog) {
    onLog("查找上传入口...");
    const fileInput = findFileInput();
    if (!fileInput) {
      throw new Error("未找到文件上传入口，请确认已在B站投稿页面");
    }
    onLog("找到上传入口，正在设置文件...");
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set;
    if (nativeSetter) {
      nativeSetter.call(fileInput, dataTransfer.files);
    } else {
      fileInput.files = dataTransfer.files;
    }
    fileInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    fileInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    onLog("文件已选择，等待上传...");
  }

  // src/content/steps/form.js
  async function stepWaitForForm(onLog) {
    onLog("等待表单加载...");
    await waitForElement(SELECTORS.titleAny, TIMEOUTS.waitForForm);
    await sleep(TIMEOUTS.afterFormLoad);
    onLog("表单已加载，开始设置");
  }
  async function stepSetTitle(title, onLog) {
    onLog(`填写标题: ${title}`);
    let input;
    try {
      input = await waitForElement(SELECTORS.titlePrecise, TIMEOUTS.titlePrecise);
    } catch (err) {
    }
    if (!input) {
      try {
        input = await waitForElement(SELECTORS.titleFallback, TIMEOUTS.titleFallback);
      } catch (err) {
        onLog("提示: 未找到标题输入框，跳过标题填写");
        return;
      }
    }
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    const applyTitle = () => {
      if (setter) setter.call(input, title);
      else input.value = title;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    };
    applyTitle();
    await sleep(TIMEOUTS.afterTitleSet);
    if ((input.value || "").trim() !== title.trim()) {
      applyTitle();
      await sleep(TIMEOUTS.afterTitleSet);
    }
    if ((input.value || "").trim() !== title.trim()) {
      onLog(`警告: 标题填写后未生效（当前值: ${input.value || "(空)"}），请检查标题框是否被锁定`);
    } else {
      onLog("标题已填写");
    }
  }
  async function stepSetDeclaration(onLog) {
    onLog("设置创作声明...");
    async function trySelectDeclaration(selectEl) {
      const trigger = selectEl.querySelector(SELECTORS.declarationTrigger);
      if (!trigger) return false;
      trigger.click();
      await sleep(TIMEOUTS.clickDropdownDelay);
      return clickDropdownOption(TEXT_KEYWORDS.declarationTarget);
    }
    for (const label of document.querySelectorAll("span, label, div")) {
      if (label.textContent.trim() === TEXT_KEYWORDS.declarationLabel) {
        const parent = label.closest(SELECTORS.declarationFormItem) || label.parentElement;
        const targetSelect = parent?.querySelector(`${SELECTORS.declarationSelect}, select, [class*="select"]`);
        if (targetSelect && await trySelectDeclaration(targetSelect)) {
          return onLog("创作声明已设置为「内容无需标注」");
        }
        break;
      }
    }
    for (const sel of document.querySelectorAll(SELECTORS.declarationSelect)) {
      if (sel.closest(".el-form-item")?.textContent.includes(TEXT_KEYWORDS.declarationLabel)) {
        if (await trySelectDeclaration(sel)) {
          return onLog("创作声明已设置为「内容无需标注」（备用方案）");
        }
      }
    }
    onLog("提示: 创作声明可能已默认为「内容无需标注」，跳过");
  }
  async function stepSetVisibility(onLog, targetText) {
    const text = targetText || "仅自己可见";
    onLog(`设置可见范围为「${text}」...`);
    const nameSpans = document.querySelectorAll(SELECTORS.visibilityName);
    for (const span of nameSpans) {
      if (span.textContent.trim() === text) {
        const container = span.closest(SELECTORS.visibilityContainer);
        if (container) {
          if (container.classList.contains("active") || container.classList.contains("checked") || container.querySelector(SELECTORS.visibilityBox)?.classList.contains("checked")) {
            onLog(`可见范围已是「${text}」`);
          } else {
            container.click();
            onLog(`可见范围已设置为「${text}」`);
          }
          await sleep(TIMEOUTS.visibilitySettle);
          return;
        }
      }
    }
    onLog("提示: 未通过 class 定位，尝试备用方案...");
    const allEls = document.querySelectorAll("div, span, label");
    for (const el of allEls) {
      const directText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      if (directText === text) {
        const clickable = el.closest(SELECTORS.visibilityContainer) || el.parentElement;
        if (clickable) {
          clickable.click();
          onLog(`可见范围已设置为「${text}」（备用方案）`);
          await sleep(TIMEOUTS.visibilitySettle);
          return;
        }
      }
    }
    onLog(`提示: 未找到可见范围「${text}」，请手动设置`);
    await sleep(TIMEOUTS.visibilitySettle);
  }

  // src/content/steps/cover.js
  async function captureFrameFromFile(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.src = URL.createObjectURL(file);
      video.muted = true;
      video.preload = "auto";
      video.addEventListener("loadeddata", () => {
        const seekTime = Math.min(2, video.duration / 2);
        video.currentTime = seekTime;
      });
      video.addEventListener("seeked", () => {
        const vw = video.videoWidth || 1280;
        const vh = video.videoHeight || 720;
        const targetRatio = 4 / 3;
        const videoRatio = vw / vh;
        let sx, sy, sw, sh;
        if (videoRatio > targetRatio) {
          sh = vh;
          sw = vh * targetRatio;
          sx = (vw - sw) / 2;
          sy = 0;
        } else {
          sw = vw;
          sh = vw / targetRatio;
          sx = 0;
          sy = (vh - sh) / 2;
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(sw);
        canvas.height = Math.round(sh);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(video.src);
          if (blob) resolve(blob);
          else reject(new Error("截帧失败"));
        }, "image/jpeg", 0.9);
      });
      video.addEventListener("error", () => {
        URL.revokeObjectURL(video.src);
        reject(new Error("视频加载失败"));
      });
      setTimeout(() => {
        URL.revokeObjectURL(video.src);
        reject(new Error("截帧超时"));
      }, TIMEOUTS.frameCapture);
    });
  }
  function setFileToInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set;
    if (nativeSetter) {
      nativeSetter.call(input, dt.files);
    } else {
      input.files = dt.files;
    }
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  function waitForCoverUploaded(timeout = TIMEOUTS.coverUploaded) {
    const getRoot = () => findCoverDialog() || document;
    const isDone = () => {
      const root = getRoot();
      const uploading = Array.from(root.querySelectorAll("*")).some((el) => {
        const t = el.textContent || "";
        return t.length < 30 && (t.includes("上传中") || /上传\s*\d+%/.test(t));
      });
      if (uploading) return false;
      const imgs = root.querySelectorAll("img");
      for (const img of imgs) {
        const src = img.getAttribute("src") || "";
        if (/^(blob:|data:)/.test(src) && img.complete && img.naturalWidth > 50 && img.naturalHeight > 50) return true;
      }
      for (const img of imgs) {
        const src = img.getAttribute("src") || "";
        if (/^https?:/.test(src) && img.complete && img.naturalWidth > 50 && img.naturalHeight > 50) return true;
      }
      return false;
    };
    if (isDone()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (isDone()) {
          obs.disconnect();
          resolve(true);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "class", "style"] });
      setTimeout(() => {
        obs.disconnect();
        resolve(false);
      }, timeout);
    });
  }
  async function confirmCoverDialog(onLog) {
    const dialog = findCoverDialog();
    const scope = dialog || document;
    const findConfirm = (root) => {
      for (const lbl of BUTTON_LABELS.coverConfirm) {
        const b = findButtonInScope(lbl, root);
        if (b) return b;
      }
      return null;
    };
    const doneBtn = await waitFor(() => findConfirm(scope), TIMEOUTS.coverConfirmBtn);
    if (doneBtn) {
      const isBtnEnabled = (btn) => {
        if (btn.disabled) return false;
        if (btn.getAttribute("aria-disabled") === "true") return false;
        if (btn.classList.contains("is-disabled") || btn.classList.contains("disabled")) return false;
        const parent = btn.closest('[class*="disabled"]');
        if (parent && parent.contains(btn)) return false;
        return true;
      };
      const enabled = await waitFor(() => isBtnEnabled(doneBtn) ? doneBtn : null, TIMEOUTS.coverConfirmEnabled);
      if (!enabled) {
        onLog("警告: 「完成」按钮 10s 后仍为禁用状态，强制点击");
      }
      const rect = doneBtn.getBoundingClientRect();
      doneBtn.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }));
      onLog("封面设置完成");
      const isDialogGone2 = (el) => {
        if (!el || !document.body.contains(el)) return true;
        const style = el.style;
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return true;
        const computed = window.getComputedStyle(el);
        if (computed.display === "none" || computed.visibility === "hidden") return true;
        return false;
      };
      if (dialog) {
        await new Promise((resolve) => {
          let tries = 0;
          const check = () => {
            tries++;
            if (isDialogGone2(dialog) || tries > TIMEOUTS.dialogGoneMaxTries) resolve();
            else setTimeout(check, TIMEOUTS.dialogGoneInterval);
          };
          check();
        });
        if (!isDialogGone2(dialog)) {
          onLog("警告: 封面弹窗似乎未关闭，将重试...");
          await sleep(500);
          const currentDialog = findCoverDialog() || dialog;
          const retryBtn = findConfirm(currentDialog);
          if (retryBtn) {
            const r = retryBtn.getBoundingClientRect();
            retryBtn.dispatchEvent(new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: r.left + r.width / 2,
              clientY: r.top + r.height / 2
            }));
            await sleep(1e3);
          }
          if (!isDialogGone2(currentDialog)) {
            throw new Error("封面弹窗重试后仍未关闭（已中止该视频，请手动设置封面）");
          }
        }
      }
    } else {
      onLog("提示: 未找到完成按钮");
      const fallback = findButtonByText(BUTTON_LABELS.coverConfirm[0]);
      if (fallback) {
        const fr = fallback.getBoundingClientRect();
        fallback.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: fr.left + fr.width / 2,
          clientY: fr.top + fr.height / 2
        }));
        onLog("（备用方案）封面设置完成");
        await sleep(500);
        const cur = findCoverDialog();
        if (cur && !isDialogGone(cur)) {
          throw new Error("封面「完成」按钮点击后弹窗未关闭（已中止该视频，请手动设置封面）");
        }
      } else {
        throw new Error("未找到封面「完成」按钮（已中止该视频，请手动设置封面）");
      }
    }
    await sleep(500);
  }
  async function stepSetCover(file, onLog) {
    onLog("设置封面...");
    let coverBtn = null;
    for (const label of BUTTON_LABELS.coverEntry) {
      coverBtn = findButtonByText(label);
      if (coverBtn) {
        onLog(`找到封面入口按钮: 「${label}」`);
        break;
      }
    }
    if (!coverBtn) {
      onLog("尝试通过页面结构定位封面区域...");
      for (const el of document.querySelectorAll("*")) {
        const directText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
        if (!BUTTON_LABELS.coverFallbackEntry.includes(directText)) continue;
        const parent = el.closest(".el-form-item") || el.parentElement;
        if (!parent) break;
        coverBtn = parent.querySelector('[style*="cursor: pointer"], [class*="cover"], [class*="btn"]');
        if (coverBtn) break;
        for (const item of parent.querySelectorAll("*")) {
          if (item.textContent.includes("封面") || item.textContent.includes("添加主封面") || item.textContent.includes("添加封面")) {
            coverBtn = item;
            break;
          }
        }
        break;
      }
    }
    if (!coverBtn) {
      throw new Error("未找到封面入口按钮（已中止该视频，请手动设置封面）");
    }
    const rect = coverBtn.getBoundingClientRect();
    coverBtn.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }));
    onLog("已点击封面入口，等待弹窗...");
    const waitForDialog = (timeout) => new Promise((resolve) => {
      const check = () => findCoverDialog();
      const existing = check();
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const d = check();
        if (d) {
          obs.disconnect();
          resolve(d);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
      setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeout);
    });
    let dialog = await waitForDialog(TIMEOUTS.coverDialogFirst);
    if (!dialog) {
      onLog("封面弹窗未出现，重试(2/3)...");
      coverBtn.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }));
      dialog = await waitForDialog(TIMEOUTS.coverDialogRetry1);
    }
    if (!dialog) {
      onLog("封面弹窗仍未出现，重试(3/3)...");
      coverBtn.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }));
      dialog = await waitForDialog(TIMEOUTS.coverDialogRetry2);
    }
    if (!dialog) {
      throw new Error("封面弹窗三次尝试后仍未出现（已中止该视频，请手动设置封面）");
    }
    onLog("封面弹窗已打开");
    let frameBlob;
    try {
      frameBlob = await captureFrameFromFile(file);
      onLog("视频截帧成功");
    } catch (err) {
      throw new Error(`封面截帧失败: ${err.message}（已中止该视频，请手动设置封面）`);
    }
    const coverFile = new File([frameBlob], "cover.jpg", { type: "image/jpeg" });
    onLog(`封面文件: ${coverFile.name}, ${(coverFile.size / 1024).toFixed(0)}KB`);
    const findCoverInput = () => {
      const allInputs = document.querySelectorAll('input[type="file"]');
      const byAccept = Array.from(allInputs).find((inp) => (inp.getAttribute("accept") || "").toLowerCase().includes("image"));
      if (byAccept) return byAccept;
      const root = findCoverDialog() || document;
      const inDialog = Array.from(root.querySelectorAll('input[type="file"]'));
      return inDialog.length ? inDialog[0] : null;
    };
    const coverInput = await waitFor(findCoverInput, 8e3);
    if (!coverInput) {
      throw new Error("未找到封面 input（已中止该视频，请手动设置封面）");
    }
    onLog(`找到封面 input: accept="${coverInput.getAttribute("accept") || "(无 accept)"}"`);
    setFileToInput(coverInput, coverFile);
    onLog("已设置封面文件，等待上传完成...");
    const uploaded = await waitForCoverUploaded();
    if (uploaded) {
      onLog("封面上传完成，预览图已显示");
    } else {
      onLog(`警告: ${TIMEOUTS.coverUploaded / 1e3}s 内未确认封面上传完成，再宽限 ${TIMEOUTS.coverGrace / 1e3}s...`);
      await sleep(TIMEOUTS.coverGrace);
      const currentDialog = findCoverDialog();
      const root = currentDialog || document;
      const imgSel = currentDialog ? 'img[src^="blob:"], img[src^="data:"], img[src^="http"]' : 'img[src^="blob:"], img[src^="data:"]';
      const previewImg = root.querySelector(imgSel);
      const hasPreview = previewImg && previewImg.complete && previewImg.naturalWidth > 50 && previewImg.naturalHeight > 50;
      if (!hasPreview) {
        throw new Error("封面上传未确认完成（已中止该视频，请手动检查封面）");
      }
      onLog("检测到封面预览");
    }
    await confirmCoverDialog(onLog);
  }

  // src/content/steps/submit.js
  async function stepSubmit(onLog) {
    onLog("准备提交稿件...");
    const MAX_WAIT = TIMEOUTS.submitWait;
    const isDisabled = (btn) => {
      if (btn.disabled) return true;
      if (btn.getAttribute("aria-disabled") === "true") return true;
      const cls = btn.className || "";
      return typeof cls === "string" && /disabled/.test(cls);
    };
    const submitBtn = await waitFor(() => {
      const btn = findButtonByText(BUTTON_LABELS.submit);
      if (!btn || isDisabled(btn)) return null;
      return btn;
    }, MAX_WAIT, 1e3);
    if (!submitBtn) {
      const exists = findButtonByText(BUTTON_LABELS.submit);
      if (exists) {
        onLog(`警告: 「立即投稿」按钮 ${MAX_WAIT / 1e3}s 内始终禁用，可能上传/封面未完成，请手动检查`);
      } else {
        onLog("警告: 未找到「立即投稿」按钮，请手动提交");
      }
      return;
    }
    submitBtn.click();
    onLog("已点击「立即投稿」");
    let disappearCount = 0;
    const confirmed = await waitFor(() => {
      const btn = findButtonByText(BUTTON_LABELS.submit);
      if (btn) {
        disappearCount = 0;
        return isDisabled(btn) ? true : null;
      }
      disappearCount++;
      return disappearCount >= 3 ? true : null;
    }, TIMEOUTS.submitVerify, 500);
    if (confirmed) {
      onLog("投稿已提交");
      return;
    }
    const msgBox = document.querySelector(SELECTORS.messageBox);
    if (msgBox) {
      onLog("检测到确认弹窗，请手动确认投稿");
      return;
    }
    onLog("警告: 未确认投稿生效，重试点击...");
    const retryBtn = findButtonByText(BUTTON_LABELS.submit);
    if (retryBtn && !isDisabled(retryBtn)) {
      retryBtn.click();
      onLog("已重试点击「立即投稿」");
    } else {
      onLog("警告: 按钮状态异常，请手动确认投稿状态");
    }
  }

  // src/content/flow.js
  async function uploadAndSubmit(file, onLog, targetText) {
    const title = parseTitle(file.name);
    onLog(`视频: ${file.name}`);
    onLog(`解析标题: ${title}`);
    onLog("");
    await runStep("stepUploadFile", stepUploadFile, file, onLog);
    await runStep("stepWaitForForm", stepWaitForForm, onLog);
    await runStep("stepSetTitle", stepSetTitle, title, onLog);
    await runStep("stepSetDeclaration", stepSetDeclaration, onLog);
    await runStep("stepSetVisibility", stepSetVisibility, onLog, targetText);
    await runStep("stepSetCover", stepSetCover, file, onLog);
    await runStep("stepSubmit", stepSubmit, onLog);
    onLog("");
    onLog(`《${title}》处理完成`);
    return { title, success: true };
  }
  async function batchUpload(files, onLog, targetText) {
    onLog("提示: 投稿期间请保持本页面可见，最小化窗口会导致浏览器节流、提交可能卡住");
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setCurrentStep({ name: `batchUpload-第${i + 1}个`, source: "" });
      onLog(`===== 第 ${i + 1}/${files.length} 个视频 =====`);
      try {
        if (i === 0) {
          await uploadAndSubmit(file, onLog, targetText);
        } else {
          onLog("查找添加分P按钮...");
          const addPartBtn = await waitFor(
            () => findButtonByText(BUTTON_LABELS.addPart[0]) || findButtonByText(BUTTON_LABELS.addPart[1]),
            1e4,
            500
          );
          if (!addPartBtn) {
            throw new Error("未找到添加分P按钮");
          }
          addPartBtn.click();
          onLog("已点击添加分P，等待文件输入框...");
          let fileInput = null;
          try {
            await waitForElement(SELECTORS.bccUploadWrapper, 15e3);
          } catch (err) {
          }
          const wrapperInputs = document.querySelectorAll(SELECTORS.bccUploadWrapper);
          for (const inp of wrapperInputs) {
            const accept = (inp.getAttribute("accept") || "").toLowerCase();
            if (VIDEO_EXTENSIONS.some((ext) => accept.includes(ext)) || accept.includes("video")) {
              fileInput = inp;
              break;
            }
          }
          if (!fileInput) {
            const allInputs = document.querySelectorAll('input[type="file"]');
            for (const inp of allInputs) {
              const accept = (inp.getAttribute("accept") || "").toLowerCase();
              if (accept.includes(".mp4") || accept.includes("video")) {
                fileInput = inp;
                break;
              }
            }
          }
          if (!fileInput) {
            throw new Error("未找到视频文件输入框");
          }
          onLog(`找到视频输入框 (display=${window.getComputedStyle(fileInput).display})`);
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set;
          const dt = new DataTransfer();
          dt.items.add(file);
          if (nativeSetter) {
            nativeSetter.call(fileInput, dt.files);
          } else {
            fileInput.files = dt.files;
          }
          fileInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          fileInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          onLog("文件已设置，等待视频卡片出现...");
          const titleKeyword = file.name.replace(/\.mp4$/i, "");
          await waitForElementByText(titleKeyword, TIMEOUTS.waitForFormEditor);
          onLog("视频卡片已出现在队列中");
          await sleep(TIMEOUTS.afterCardAppear);
          onLog("点击视频卡片...");
          let bestEl = null, bestSize = Infinity;
          for (const el of document.querySelectorAll("*")) {
            const text = el.textContent || "";
            if (text.includes(titleKeyword) && text.length < 200) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 100 && rect.height > 30) {
                const size = rect.width * rect.height;
                if (size < bestSize) {
                  bestSize = size;
                  bestEl = el;
                }
              }
            }
          }
          if (!bestEl) throw new Error(`未能点击视频卡片: ${titleKeyword}`);
          const clickable = toClickable(bestEl);
          if (clickable && clickable !== bestEl) {
            onLog(`找到可点击父元素: ${clickable.tagName}`);
            const rect = clickable.getBoundingClientRect();
            clickable.dispatchEvent(new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2
            }));
          } else {
            bestEl.click();
          }
          onLog("已点击视频卡片");
          onLog("等待编辑页面加载...");
          await waitForElement(SELECTORS.titleAny.slice(0, 2), TIMEOUTS.waitForFormEditor);
          await sleep(TIMEOUTS.afterFormLoad);
          onLog("已进入编辑页面");
          await runStep("stepWaitForForm", stepWaitForForm, onLog);
          await runStep("stepSetDeclaration", stepSetDeclaration, onLog);
          await runStep("stepSetVisibility", stepSetVisibility, onLog, targetText);
          await runStep("stepSetCover", stepSetCover, file, onLog);
          await runStep("stepSubmit", stepSubmit, onLog);
          onLog("");
          onLog(`第 ${i + 1} 个视频处理完成`);
        }
      } catch (err) {
        recordError(err, { 批次: `第 ${i + 1}/${files.length} 个`, 文件: file.name });
        onLog(`第 ${i + 1} 个视频失败: ${err.message}`);
      }
    }
    onLog("===== 全部处理完成 =====");
  }

  // src/content/ui/panel.js
  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "bili-helper-panel";
    panel.innerHTML = `
    <div class="bili-helper-header">
      <span class="bili-helper-title">B站投稿助手</span>
      <button class="bili-helper-minimize" id="bili-helper-min">—</button>
    </div>
    <div class="bili-helper-body" id="bili-helper-body">
      <div class="bili-helper-section">
        <p class="bili-helper-desc">选择合并好的MP4文件，自动上传并提交到B站</p>
        <div class="bili-helper-setting-row">
          <span class="bili-helper-setting-label">可见范围</span>
          <select class="bili-helper-setting-select" id="bili-helper-visibility">
            <option value="公开可见">公开可见</option>
            <option value="仅自己可见" selected>仅自己可见</option>
          </select>
        </div>
        <label class="bili-helper-file-btn">
          选择MP4文件
          <input type="file" id="bili-helper-files" multiple accept=".mp4" style="display:none" />
        </label>
      </div>
      <div id="bili-helper-file-list" style="display:none">
        <p class="bili-helper-file-count" id="bili-helper-count"></p>
        <div id="bili-helper-files-preview"></div>
        <button class="bili-helper-upload-btn" id="bili-helper-start">开始自动上传</button>
      </div>
      <div id="bili-helper-log" style="display:none">
        <button class="bili-helper-copy-btn" id="bili-helper-copy-report">📋 复制错误包（粘贴给 AI）</button>
        <pre id="bili-helper-log-content"></pre>
      </div>
    </div>
  `;
    document.body.appendChild(panel);
    const savedVisibility = localStorage.getItem(STORAGE_KEYS.visibility);
    if (savedVisibility) {
      const select = document.getElementById("bili-helper-visibility");
      select.value = savedVisibility;
    }
    document.getElementById("bili-helper-visibility").addEventListener("change", (e) => {
      localStorage.setItem(STORAGE_KEYS.visibility, e.target.value);
    });
    let minimized = false;
    document.getElementById("bili-helper-min").addEventListener("click", () => {
      minimized = !minimized;
      const body = document.getElementById("bili-helper-body");
      body.style.display = minimized ? "none" : "block";
      document.getElementById("bili-helper-min").textContent = minimized ? "+" : "—";
    });
    document.getElementById("bili-helper-copy-report").addEventListener("click", async () => {
      const btn = document.getElementById("bili-helper-copy-report");
      let reports = [];
      try {
        reports = JSON.parse(localStorage.getItem(STORAGE_KEYS.errorReports) || "[]");
      } catch (e) {
        reports = [];
      }
      if (!Array.isArray(reports) || !reports.length) {
        btn.textContent = "暂无错误报告";
        setTimeout(() => {
          btn.textContent = "📋 复制错误包（粘贴给 AI）";
        }, 1500);
        return;
      }
      const md = formatReportMarkdown(reports[reports.length - 1]);
      try {
        await navigator.clipboard.writeText(md);
        btn.textContent = "✅ 已复制，粘贴给 AI 即可";
      } catch (e) {
        try {
          const ta = document.createElement("textarea");
          ta.value = md;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(ta);
          btn.textContent = ok ? "✅ 已复制（兜底方式）" : "⚠️ 复制失败，请手动复制日志";
        } catch (e2) {
          btn.textContent = "⚠️ 复制失败";
        }
      }
      setTimeout(() => {
        btn.textContent = "📋 复制错误包（粘贴给 AI）";
      }, 2500);
    });
    const startBtn = document.getElementById("bili-helper-start");
    const startClickHandler = async () => {
      const files = Array.from(document.getElementById("bili-helper-files").files);
      if (files.length === 0) return;
      logBuffer.length = 0;
      startBtn.disabled = true;
      startBtn.textContent = "上传中...";
      const logDiv = document.getElementById("bili-helper-log");
      const logContent = document.getElementById("bili-helper-log-content");
      logDiv.style.display = "block";
      logContent.textContent = "";
      const onLog = (msg) => {
        logBuffer.push(msg);
        if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
        logContent.textContent += msg + "\n";
        logContent.scrollTop = logContent.scrollHeight;
      };
      setIsUploading(true);
      try {
        const visText = document.getElementById("bili-helper-visibility").value;
        await batchUpload(files, onLog, visText);
        startBtn.textContent = "全部完成";
      } catch (err) {
        recordError(err);
        onLog(`错误: ${err.message}`);
        startBtn.textContent = "出错，请重试";
      } finally {
        setIsUploading(false);
        startBtn.disabled = false;
      }
    };
    document.getElementById("bili-helper-files").addEventListener("change", (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;
      document.getElementById("bili-helper-file-list").style.display = "block";
      document.getElementById("bili-helper-count").textContent = `已选择 ${files.length} 个视频文件`;
      const preview = document.getElementById("bili-helper-files-preview");
      preview.innerHTML = "";
      files.forEach((f, i) => {
        const div = document.createElement("div");
        div.className = "bili-helper-file-item";
        div.textContent = `${i + 1}. ${f.name} (${(f.size / 1024 / 1024).toFixed(1)}MB)`;
        div.title = `标题: ${parseTitle(f.name)}`;
        preview.appendChild(div);
      });
      startBtn.removeEventListener("click", startClickHandler);
      startBtn.addEventListener("click", startClickHandler);
    });
  }

  // src/content/index.js
  (function() {
    "use strict";
    if (document.getElementById("bili-helper-panel")) return;
    createPanel();
    console.log("[B站投稿助手] 面板已注入");
    let hiddenSince = null;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        hiddenSince = Date.now();
      } else if (hiddenSince) {
        const seconds = Math.round((Date.now() - hiddenSince) / 1e3);
        if (isUploading && seconds >= 2) {
          const msg = `⚠️ 页面曾被隐藏 ${seconds}s，期间浏览器可能节流了投稿流程，请确认投稿状态`;
          logBuffer.push(msg);
          if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
          const content = document.getElementById("bili-helper-log-content");
          if (content) {
            content.textContent += msg + "\n";
            content.scrollTop = content.scrollHeight;
          }
          console.log("[B站投稿助手]", msg);
        }
        hiddenSince = null;
      }
    });
    const urlParams = new URLSearchParams(window.location.search);
    const autoFilesParam = urlParams.get("autoFiles");
    if (autoFilesParam) {
      urlParams.delete("autoFiles");
      const newSearch = urlParams.toString();
      history.replaceState(null, "", location.pathname + (newSearch ? "?" + newSearch : "") + location.hash);
      const fileUrls = autoFilesParam.split(",").map((u) => decodeURIComponent(u.trim())).filter(Boolean);
      if (fileUrls.length > 0) {
        console.log("[B站投稿助手] 检测到自动上传参数，文件数:", fileUrls.length);
        const serverBaseUrl = fileUrls[0].split("?")[0];
        setTimeout(async () => {
          logBuffer.length = 0;
          const logDiv = document.getElementById("bili-helper-log");
          const logContent = document.getElementById("bili-helper-log-content");
          if (logDiv) logDiv.style.display = "block";
          const onLog = (msg) => {
            if (logContent) {
              logBuffer.push(msg);
              if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
              logContent.textContent += msg + "\n";
              logContent.scrollTop = logContent.scrollHeight;
            }
            console.log("[B站投稿助手]", msg);
          };
          onLog("收到视频合并app的自动上传指令...");
          setIsUploading(true);
          try {
            const files = [];
            for (let i = 0; i < fileUrls.length; i++) {
              onLog(`正在获取第 ${i + 1}/${fileUrls.length} 个视频...`);
              const resp = await fetch(fileUrls[i]);
              if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
              const blob = await resp.blob();
              const urlObj = new URL(fileUrls[i]);
              const fileName = urlObj.searchParams.get("name") || `video_${i + 1}.mp4`;
              files.push(new File([blob], fileName, { type: "video/mp4" }));
              onLog(`已获取: ${fileName} (${(blob.size / 1024 / 1024).toFixed(1)}MB)`);
            }
            onLog(`共获取 ${files.length} 个视频，开始自动上传...`);
            onLog("");
            const visText = document.getElementById("bili-helper-visibility").value;
            await batchUpload(files, onLog, visText);
            onLog("");
            onLog("===== 全部处理完成 =====");
            try {
              await fetch(serverBaseUrl + "?signal=done");
              onLog("已通知 app 关闭");
            } catch (e) {
              console.log("[B站投稿助手] 发送完成信号失败:", e);
            }
          } catch (err) {
            recordError(err);
            onLog(`错误: ${err.message}`);
          } finally {
            setIsUploading(false);
          }
        }, 3e3);
      }
    }
  })();
})();
