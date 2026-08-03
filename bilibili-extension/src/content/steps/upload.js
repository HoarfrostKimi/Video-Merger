// steps/upload.js - Step 1: 上传视频文件
import { findFileInput } from '../core/find.js'

/**
 * Step 1: 上传视频文件
 */
export async function stepUploadFile(file, onLog) {
  onLog('查找上传入口...')
  const fileInput = findFileInput()
  if (!fileInput) {
    throw new Error('未找到文件上传入口，请确认已在B站投稿页面')
  }
  onLog('找到上传入口，正在设置文件...')

  const dataTransfer = new DataTransfer()
  dataTransfer.items.add(file)
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set
  if (nativeSetter) {
    nativeSetter.call(fileInput, dataTransfer.files)
  } else {
    fileInput.files = dataTransfer.files
  }
  fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  onLog('文件已选择，等待上传...')
}
