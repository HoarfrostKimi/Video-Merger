// flow.js - 主流程编排：uploadAndSubmit / batchUpload
import { sleep, waitFor, waitForElement, waitForElementByText } from './core/wait.js'
import { findButtonByText, toClickable } from './core/find.js'
import { parseTitle } from './core/title.js'
import { runStep, recordError, setCurrentStep } from './core/errorReport.js'
import { stepUploadFile } from './steps/upload.js'
import { stepWaitForForm, stepSetTitle, stepSetDeclaration, stepSetVisibility } from './steps/form.js'
import { stepSetCover } from './steps/cover.js'
import { stepSubmit } from './steps/submit.js'
import { BUTTON_LABELS, SELECTORS, TIMEOUTS, VIDEO_EXTENSIONS } from './config.js'

/**
 * 上传并自动投稿一个视频
 */
export async function uploadAndSubmit(file, onLog, targetText) {
  const title = parseTitle(file.name)
  onLog(`视频: ${file.name}`)
  onLog(`解析标题: ${title}`)
  onLog('')

  // Step 1: 上传文件
  await runStep('stepUploadFile', stepUploadFile, file, onLog)

  // Step 2: 等待表单加载
  await runStep('stepWaitForForm', stepWaitForForm, onLog)

  // Step 3: 填写标题
  await runStep('stepSetTitle', stepSetTitle, title, onLog)

  // Step 4: 设置创作声明
  await runStep('stepSetDeclaration', stepSetDeclaration, onLog)

  // Step 5: 设置可见范围
  await runStep('stepSetVisibility', stepSetVisibility, onLog, targetText)

  // Step 6: 设置封面（截取视频帧作为自定义封面）
  await runStep('stepSetCover', stepSetCover, file, onLog)

  // Step 7: 提交
  await runStep('stepSubmit', stepSubmit, onLog)

  onLog('')
  onLog(`《${title}》处理完成`)
  return { title, success: true }
}

/**
 * 批量上传：第一个视频正常上传，后续点击队列卡片进入编辑页面再上传
 */
export async function batchUpload(files, onLog, targetText) {
  onLog('提示: 投稿期间请保持本页面可见，最小化窗口会导致浏览器节流、提交可能卡住')
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    // 重置当前步骤标记：批次内非 runStep 错误（如找不到按钮）也能定位到具体第几个
    setCurrentStep({ name: `batchUpload-第${i + 1}个`, source: '' })
    onLog(`===== 第 ${i + 1}/${files.length} 个视频 =====`)

    try {
      if (i === 0) {
        // 第一个视频：通过主文件输入框上传
        await uploadAndSubmit(file, onLog, targetText)
      } else {
        // 后续视频：通过"添加分P"按钮上传
        onLog('查找添加分P按钮...')

        // 找"添加分P"按钮（等它出现，替代固定 sleep，慢网时不丢时序）
        const addPartBtn = await waitFor(
          () => findButtonByText(BUTTON_LABELS.addPart[0]) || findButtonByText(BUTTON_LABELS.addPart[1]),
          10000, 500
        )
        if (!addPartBtn) {
          throw new Error('未找到添加分P按钮')
        }

        // 点击"添加分P"按钮
        addPartBtn.click()
        onLog('已点击添加分P，等待文件输入框...')

        // 等待并定位视频文件输入框（替代固定 sleep(2000)，等状态而非干等）
        let fileInput = null
        try {
          await waitForElement(SELECTORS.bccUploadWrapper, 15000)
        } catch (err) { /* wrapper 未出现，尝试 fallback */ }
        const wrapperInputs = document.querySelectorAll(SELECTORS.bccUploadWrapper)
        for (const inp of wrapperInputs) {
          const accept = (inp.getAttribute('accept') || '').toLowerCase()
          if (VIDEO_EXTENSIONS.some((ext) => accept.includes(ext)) || accept.includes('video')) {
            fileInput = inp
            break
          }
        }

        if (!fileInput) {
          // fallback: 找第一个视频格式的 input
          const allInputs = document.querySelectorAll('input[type="file"]')
          for (const inp of allInputs) {
            const accept = (inp.getAttribute('accept') || '').toLowerCase()
            if (accept.includes('.mp4') || accept.includes('video')) {
              fileInput = inp
              break
            }
          }
        }

        if (!fileInput) {
          throw new Error('未找到视频文件输入框')
        }

        onLog(`找到视频输入框 (display=${window.getComputedStyle(fileInput).display})`)

        // 用原生 setter 设置文件（Vue 兼容）
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set
        const dt = new DataTransfer()
        dt.items.add(file)
        if (nativeSetter) {
          nativeSetter.call(fileInput, dt.files)
        } else {
          fileInput.files = dt.files
        }
        fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
        fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        onLog('文件已设置，等待视频卡片出现...')

        // 等待视频卡片出现在队列中（MutationObserver 替代 setInterval 轮询）
        // 用去扩展名的完整文件名作为关键词（含日期）：区分度最高，同系列不同日期不会点错旧卡片
        const titleKeyword = file.name.replace(/\.mp4$/i, '')
        await waitForElementByText(titleKeyword, TIMEOUTS.waitForFormEditor)
        onLog('视频卡片已出现在队列中')
        await sleep(TIMEOUTS.afterCardAppear)

        // 点击视频卡片进入编辑页面
        onLog('点击视频卡片...')
        let bestEl = null, bestSize = Infinity
        for (const el of document.querySelectorAll('*')) {
          const text = el.textContent || ''
          if (text.includes(titleKeyword) && text.length < 200) {
            const rect = el.getBoundingClientRect()
            if (rect.width > 100 && rect.height > 30) {
              const size = rect.width * rect.height
              if (size < bestSize) { bestSize = size; bestEl = el }
            }
          }
        }
        if (!bestEl) throw new Error(`未能点击视频卡片: ${titleKeyword}`)

        const clickable = toClickable(bestEl)
        if (clickable && clickable !== bestEl) {
          onLog(`找到可点击父元素: ${clickable.tagName}`)
          const rect = clickable.getBoundingClientRect()
          clickable.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, view: window,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
          }))
        } else {
          bestEl.click()
        }
        onLog('已点击视频卡片')

        // 等待编辑页面加载
        onLog('等待编辑页面加载...')
        await waitForElement(SELECTORS.titleAny.slice(0, 2), TIMEOUTS.waitForFormEditor)
        await sleep(TIMEOUTS.afterFormLoad)
        onLog('已进入编辑页面')

        // 填表
        await runStep('stepWaitForForm', stepWaitForForm, onLog)
        // 注意：分P分支不填写标题——B站分P标题默认使用文件名（行为稳定），
        // 且此处页面上同时存在主标题框与分P标题框，显式填写容易覆盖主稿件标题
        await runStep('stepSetDeclaration', stepSetDeclaration, onLog)
        await runStep('stepSetVisibility', stepSetVisibility, onLog, targetText)
        await runStep('stepSetCover', stepSetCover, file, onLog)
        await runStep('stepSubmit', stepSubmit, onLog)

        onLog('')
        onLog(`第 ${i + 1} 个视频处理完成`)
      }
    } catch (err) {
      recordError(err, { 批次: `第 ${i + 1}/${files.length} 个`, 文件: file.name })
      onLog(`第 ${i + 1} 个视频失败: ${err.message}`)
    }
  }
  onLog('===== 全部处理完成 =====')
}
