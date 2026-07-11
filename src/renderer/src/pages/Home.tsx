import { useState, useEffect, useCallback, useRef } from 'react'
import { Layout, Button, Space, Tag, message, Typography, Empty, Progress, Card } from 'antd'
import { MergeCellsOutlined, BulbOutlined, BulbFilled, SettingOutlined, UploadOutlined } from '@ant-design/icons'
import SettingsDrawer from './SettingsDrawer'
import FolderToolbar from '../components/FolderToolbar'
import MergeTable from '../components/MergeTable'
import SubFileList from '../components/SubFileList'
import HiddenFoldersPanel from '../components/HiddenFoldersPanel'
import MergeActionBar from '../components/MergeActionBar'
import UploadModal from '../components/UploadModal'
import { formatPercent, formatTime } from '../utils/format'

const { Header, Content } = Layout
const { Title, Text } = Typography

interface HomeProps {
  darkMode: boolean
  onToggleDarkMode: (value: boolean) => void
}

function Home({ darkMode, onToggleDarkMode }: HomeProps): JSX.Element {
  const [inputFolder, setInputFolder] = useState('')
  const [outputFolder, setOutputFolder] = useState('')
  const [folders, setFolders] = useState<FolderGroup[]>([])
  const [hiddenFolderKeys, setHiddenFolderKeys] = useState<string[]>([])
  const [hiddenFolders, setHiddenFolders] = useState<FolderGroup[]>([])
  const [showHidden, setShowHidden] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [scanning, setScanning] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState('')
  const [selectedFolder, setSelectedFolder] = useState<FolderGroup | null>(null)
  const [maxIntervalHours, setMaxIntervalHours] = useState(2.5)
  const [concurrency, setConcurrency] = useState(3)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [batchProgress, setBatchProgress] = useState<Record<string, number>>({})
  const [autoOpenWebsite, setAutoOpenWebsite] = useState(true)
  const [autoOpenFolder, setAutoOpenFolder] = useState(true)
  const [pluginLinkage, setPluginLinkage] = useState(false)
  const [autoCloseBrowser, setAutoCloseBrowser] = useState(false)
  const [autoCloseApp, setAutoCloseApp] = useState(true)
  const [runInBackground, setRunInBackground] = useState(false)
  const [controlEnabled, setControlEnabled] = useState(true)
  const [controlPort, setControlPort] = useState(9820)
  const [controlPassword, setControlPassword] = useState('')
  const [controlUrl, setControlUrl] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  // 投稿弹窗状态
  const [mergedFiles, setMergedFiles] = useState<Array<{ index: number; name: string; path: string; mtime: number }>>([])
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [uploadSelectedKeys, setUploadSelectedKeys] = useState<React.Key[]>([])
  const [uploading, setUploading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pluginPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const websiteOpenedRef = useRef(false)
  const folderOpenedRef = useRef(false)

  useEffect(() => {
    if (!window.api) return
    ;(async () => {
      // 第一步：加载配置
      let loadedInputFolder = ''
      let loadedOutputFolder = ''
      let loadedHiddenKeys: string[] = []
      try {
        const config = await window.api.loadConfig()
        if (config.inputFolder) {
          loadedInputFolder = config.inputFolder
          setInputFolder(config.inputFolder)
        }
        if (config.outputFolder) {
          setOutputFolder(config.outputFolder)
        }
        if (config.maxIntervalHours !== undefined) {
          setMaxIntervalHours(config.maxIntervalHours)
        }
        if (config.concurrency !== undefined) {
          setConcurrency(config.concurrency)
        }
        if (config.autoOpenWebsite !== undefined) {
          setAutoOpenWebsite(config.autoOpenWebsite)
        }
        if (config.autoOpenFolder !== undefined) {
          setAutoOpenFolder(config.autoOpenFolder)
        }
        if (config.pluginLinkage !== undefined) {
          setPluginLinkage(config.pluginLinkage)
        }
        if (config.autoCloseBrowser !== undefined) {
          setAutoCloseBrowser(config.autoCloseBrowser)
        }
        if (config.autoCloseApp !== undefined) {
          setAutoCloseApp(config.autoCloseApp)
        }
        if (config.runInBackground !== undefined) {
          setRunInBackground(config.runInBackground)
        }
        if (config.controlEnabled !== undefined) {
          setControlEnabled(config.controlEnabled)
        }
        if (config.controlPort !== undefined) {
          setControlPort(config.controlPort)
        }
        if (config.controlPassword !== undefined) {
          setControlPassword(config.controlPassword)
        }
        if (config.hiddenFolderKeys && Array.isArray(config.hiddenFolderKeys)) {
          loadedHiddenKeys = config.hiddenFolderKeys
          setHiddenFolderKeys(config.hiddenFolderKeys)
        }
      } catch (err) {
        console.warn('加载配置失败:', err)
      }

      // 获取手机控制地址
      try {
        const url = await window.api.getControlUrl()
        setControlUrl(url)
      } catch {
        // ignore
      }

      // 加载已合并文件列表（投稿页使用）
      try {
        const list = await window.api.getMergedFiles()
        setMergedFiles(list)
      } catch {
        // ignore
      }

      // 第二步：配置加载完成后，立即自动扫描（使用刚加载的排除列表）
      if (loadedInputFolder) {
        try {
          setScanning(true)
          const result: ScanResult = await window.api.scanFlvFiles(loadedInputFolder, 2.5, loadedOutputFolder)
          const hiddenSet = new Set(loadedHiddenKeys)
          const filtered = result.folders.filter((f) => !hiddenSet.has(f.key))
          const hidden = result.folders.filter((f) => hiddenSet.has(f.key))
          setFolders(filtered)
          setHiddenFolders(hidden)
          setSelectedRowKeys([])
          setSelectedFolder(null)
          const totalFiles = filtered.reduce((s, g) => s + g.fileCount, 0)
          if (totalFiles > 0) {
            message.success(`自动扫描完成，找到 ${filtered.length} 组待合并，共 ${totalFiles} 个片段`)
          }
        } catch {
          // ignore
        } finally {
          setScanning(false)
        }
      }
    })()
  }, [])

  // 监听配置变更（手机端操作后同步）
  useEffect(() => {
    if (!window.api) return
    const unsubscribe = window.api.onConfigUpdated(async () => {
      console.log('[Home] 收到配置变更通知，重新加载配置')
      try {
        const config = await window.api!.loadConfig()
        if (config.hiddenFolderKeys && Array.isArray(config.hiddenFolderKeys)) {
          setHiddenFolderKeys(config.hiddenFolderKeys)
        }
      } catch (err) {
        console.warn('重新加载配置失败:', err)
      }
    })
    return unsubscribe
  }, [])

  const genMergeFileName = useCallback((folder: FolderGroup) => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `${folder.date}_${folder.title}_${dateStr}_${timeStr}_合并版`
  }, [])

  const handleSelectInputFolder = useCallback(async () => {
    if (!window.api) return
    try {
      const folder = await window.api.selectFolder()
      setInputFolder(folder)
      if (!outputFolder) {
        setOutputFolder(folder)
      }
      setFolders([])
      setHiddenFolderKeys([])
      setHiddenFolders([])
      setShowHidden(false)
      setSelectedRowKeys([])
      setSelectedFolder(null)
    } catch (err: any) {
      message.error(err.message || '选择文件夹失败')
    }
  }, [outputFolder])

  const handleSelectOutputFolder = useCallback(async () => {
    if (!window.api) return
    try {
      const folder = await window.api.selectOutputFolder()
      setOutputFolder(folder)
    } catch (err: any) {
      message.error(err.message || '选择输出文件夹失败')
    }
  }, [])

  const handleScan = useCallback(async () => {
    if (!window.api) return
    if (!inputFolder) {
      message.warning('请先选择输入文件夹')
      return
    }
    setScanning(true)
    try {
      const result: ScanResult = await window.api.scanFlvFiles(inputFolder, maxIntervalHours, outputFolder || undefined)
      const hiddenSet = new Set(hiddenFolderKeys)
      const filtered = result.folders.filter((f) => !hiddenSet.has(f.key))
      // 保存被排除的完整对象用于显示
      const hidden = result.folders.filter((f) => hiddenSet.has(f.key))
      setFolders(filtered)
      setHiddenFolders(hidden)
      setSelectedRowKeys([])
      setSelectedFolder(null)
      const totalFiles = filtered.reduce((s, g) => s + g.fileCount, 0)
      message.success(`扫描完成，找到 ${filtered.length} 组待合并，共 ${totalFiles} 个片段`)
    } catch (err: any) {
      message.error(err.message || '扫描失败')
    } finally {
      setScanning(false)
    }
  }, [inputFolder, hiddenFolderKeys, maxIntervalHours, outputFolder])

  // 加载已合并文件列表（投稿用）
  const loadMergedFiles = useCallback(async () => {
    if (!window.api) return
    try {
      const list = await window.api.getMergedFiles()
      setMergedFiles(list)
    } catch {
      // ignore
    }
  }, [])

  const handleMerge = useCallback(async () => {
    if (!window.api) return
    if (selectedRowKeys.length === 0) {
      message.warning('请至少选择1个文件夹进行合并')
      return
    }
    if (!outputFolder) {
      message.warning('请先选择输出文件夹')
      return
    }

    setProcessing(true)
    setProgress(0)
    setElapsedSeconds(0)
    setBatchProgress({})

    // 准备批量合并任务
    const tasks = selectedRowKeys.map((key) => {
      const folder = folders.find((f) => f.key === key)
      if (!folder) throw new Error(`找不到分组: ${key}`)

      const outputFileName = genMergeFileName(folder)
      const outputPath = outputFolder.replace(/[\\/]$/, '') + '/' + outputFileName + '.mp4'
      const filePaths = folder.files.map((f) => f.path)

      return {
        taskId: folder.key,
        filePaths,
        outputPath,
        folderName: folder.folderName
      }
    })

    // 启动统一轮询（1秒间隔）：同时更新进度和已用时间
    timerRef.current = setInterval(async () => {
      setElapsedSeconds((prev) => prev + 1)
      try {
        const progress = await window.api!.getBatchProgress()
        setBatchProgress(progress)
        // 计算总体进度
        const values = Object.values(progress)
        if (values.length > 0) {
          const totalProgress = values.reduce((sum, p) => sum + Math.max(0, p), 0) / values.length
          setProgress(totalProgress)
        }
      } catch (err) {
        console.warn('批量进度轮询失败:', err)
      }
    }, 1000)

    try {
      setStatusText(`正在并行合并 ${tasks.length} 个分组（并发数: ${concurrency}）`)

      // 调用批量合并API
      const results = await window.api.batchMergeVideos(tasks, concurrency)

      // 统计结果
      let successCount = 0
      let failCount = 0
      const successKeys: string[] = []

      for (const result of results) {
        if (result.success) {
          successCount++
          successKeys.push(result.taskId)
          if (result.warning) {
            message.warning(result.warning)
          }
        } else {
          failCount++
          message.error(`合并 ${result.folderName} 失败: ${result.error}`)
        }
      }

      // 移除成功的分组
      setFolders((prev) => prev.filter((f) => !successKeys.includes(f.key)))
      setSelectedRowKeys((prev) => prev.filter((k) => !successKeys.includes(k as string)))

      setProgress(100)
      setStatusText('')

      // 刷新已合并文件列表（更新投稿角标）
      loadMergedFiles()

      // 合并完成后自动打开输出文件夹和B站投稿页面（仅首次）
      if (successCount > 0 && window.api && outputFolder) {
        try {
          if (autoOpenFolder && !folderOpenedRef.current) {
            await window.api.openDirectory(outputFolder)
            folderOpenedRef.current = true
          }
          // 根据开关状态和是否已打开过来决定是否打开网站
          if (autoOpenWebsite && !websiteOpenedRef.current) {
            // 如果开启了插件联动，注册文件并传递 URL
            const successTasks = tasks.filter((t) => successKeys.includes(t.taskId))
            const fileUrls: string[] = []
            if (pluginLinkage) {
              for (const task of successTasks) {
                try {
                  const url = await window.api.registerFileForServe(task.outputPath)
                  fileUrls.push(url)
                } catch {
                  // 单个文件注册失败不影响其他
                }
              }
            }
            // 打开B站投稿页面，带文件 URL 参数（仅插件联动时）
            let bilibiliUrl = 'https://member.bilibili.com/platform/upload/video/frame'
            if (fileUrls.length > 0) {
              bilibiliUrl += '?autoFiles=' + fileUrls.map(u => encodeURIComponent(u)).join(',')
            }

            // 插件联动且开启最小化设置时，先记住当前前台窗口
            let prevHwnd = 0
            if (pluginLinkage && fileUrls.length > 0 && autoCloseBrowser) {
              prevHwnd = await window.api.getForegroundWindow()
            }

            await window.api.openExternal(bilibiliUrl)
            websiteOpenedRef.current = true

            // 插件联动且开启最小化设置时，仅当浏览器抢了焦点才最小化它
            if (pluginLinkage && fileUrls.length > 0 && autoCloseBrowser) {
              window.api.minimizeBrowser(prevHwnd)
            }

            // 插件联动开启时，轮询等待插件完成投稿，然后根据设置关闭
            if (pluginLinkage && fileUrls.length > 0) {
              let pollCount = 0
              const maxPoll = 600 // 最多等10分钟
              // 清理之前的插件轮询定时器（如果有）
              if (pluginPollTimerRef.current) clearInterval(pluginPollTimerRef.current)
              pluginPollTimerRef.current = setInterval(async () => {
                pollCount++
                try {
                  const done = await window.api.checkUploadDone()
                  if (done) {
                    if (pluginPollTimerRef.current) clearInterval(pluginPollTimerRef.current)
                    pluginPollTimerRef.current = null
                    console.log('[App] 插件投稿完成')
                    // 根据设置决定是否关闭 App
                    if (autoCloseApp) {
                      console.log('[App] 自动关闭 App')
                      window.close()
                    } else {
                      console.log('[App] 不自动关闭 App')
                    }
                  }
                } catch {
                  // ignore
                }
                if (pollCount >= maxPoll) {
                  if (pluginPollTimerRef.current) clearInterval(pluginPollTimerRef.current)
                  pluginPollTimerRef.current = null
                }
              }, 1000)
            }
          }
        } catch {
          // ignore
        }
      }

      if (failCount > 0) {
        message.warning(`合并完成：成功 ${successCount} 组，失败 ${failCount} 组`)
      } else {
        message.success(`合并完成！共处理 ${successCount} 组`)
      }
    } catch (err: any) {
      message.error(`批量合并失败: ${err.message}`)
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      if (pluginPollTimerRef.current) clearInterval(pluginPollTimerRef.current)
      setProcessing(false)
    }
  }, [selectedRowKeys, folders, outputFolder, genMergeFileName, concurrency, loadMergedFiles])

  const handleOpenDirectory = useCallback(async () => {
    if (!window.api) return
    if (!inputFolder) {
      message.warning('请先选择文件夹')
      return
    }
    try {
      await window.api.openDirectory(inputFolder)
    } catch (err: any) {
      message.error(err.message || '打开目录失败')
    }
  }, [inputFolder])

  // 排除选中的分组（移到隐藏列表）
  const handleHideSelected = useCallback(() => {
    if (selectedRowKeys.length === 0) {
      message.warning('请先选择要排除的分组')
      return
    }
    const toHide = folders.filter((f) => selectedRowKeys.includes(f.key))
    const newKeys = [...hiddenFolderKeys, ...toHide.map((f) => f.key)]
    setHiddenFolderKeys(newKeys)
    setHiddenFolders((prev) => [...prev, ...toHide])
    setFolders((prev) => prev.filter((f) => !selectedRowKeys.includes(f.key)))
    setSelectedRowKeys([])
    setSelectedFolder(null)
    if (window.api) window.api.saveConfig({ hiddenFolderKeys: newKeys })
    message.success(`已排除 ${toHide.length} 个分组`)
  }, [selectedRowKeys, folders])

  // 恢复单个隐藏分组
  const handleRestoreOne = useCallback((key: string) => {
    const folder = hiddenFolders.find((f) => f.key === key)
    if (!folder) return
    const newKeys = hiddenFolderKeys.filter((k) => k !== key)
    setHiddenFolderKeys(newKeys)
    setHiddenFolders((prev) => prev.filter((f) => f.key !== key))
    setFolders((prev) => [...prev, folder])
    if (window.api) window.api.saveConfig({ hiddenFolderKeys: newKeys })
    message.success(`已恢复：${folder.folderName}`)
  }, [hiddenFolders, hiddenFolderKeys])

  // 恢复所有隐藏分组
  const handleRestoreAll = useCallback(() => {
    setFolders((prev) => [...prev, ...hiddenFolders])
    setHiddenFolderKeys([])
    setHiddenFolders([])
    setShowHidden(false)
    if (window.api) window.api.saveConfig({ hiddenFolderKeys: [] })
    message.success(`已恢复全部 ${hiddenFolders.length} 个分组`)
  }, [hiddenFolders])

  const handleRowClick = (record: FolderGroup) => {
    setSelectedFolder(record)
  }

  // 投稿上传处理
  const handleUpload = useCallback(async (selectedPaths: string[]) => {
    if (!window.api) return
    setUploading(true)
    try {
      await window.api.uploadMergedFiles(selectedPaths)
      message.success('已打开B站投稿页面')
      // 刷新列表
      const list = await window.api.getMergedFiles()
      setMergedFiles(list)
      setUploadSelectedKeys([])
      setShowUploadModal(false)
    } catch (err: any) {
      message.error(err.message || '投稿失败')
    } finally {
      setUploading(false)
    }
  }, [])

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          background: 'var(--color-bg-header)',
          padding: '0 28px',
          display: 'flex',
          alignItems: 'center',
          height: 56,
          borderBottom: '1px solid var(--color-border-base)',
          boxShadow: 'var(--shadow-header)',
          transition: 'background-color 0.3s ease, border-color 0.3s ease',
          position: 'sticky',
          top: 0,
          zIndex: 10
        }}
      >
        <Title level={4} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <MergeCellsOutlined style={{ fontSize: 22, color: 'var(--color-primary)' }} /> 视频自动合并工具
        </Title>
        <Tag color="green" style={{ marginLeft: 16 }}>FFmpeg 就绪</Tag>
        <div style={{ flex: 1 }} />
        <Space size={8}>
          <Button
            icon={<UploadOutlined />}
            onClick={() => {
              loadMergedFiles()
              setShowUploadModal(true)
            }}
            title="待投稿文件"
          >
            投稿
          </Button>
          <Button
            icon={<SettingOutlined />}
            onClick={() => setShowSettings(true)}
            title="设置"
          />
          <Button
            icon={darkMode ? <BulbFilled style={{ color: '#faad14' }} /> : <BulbOutlined />}
            onClick={() => onToggleDarkMode(!darkMode)}
            title={darkMode ? '切换到浅色模式' : '切换到深色模式'}
          >
            {darkMode ? '深色' : '浅色'}
          </Button>
        </Space>
      </Header>

      <Content style={{ padding: '24px 28px', overflow: 'auto' }}>
        <FolderToolbar
          inputFolder={inputFolder}
          outputFolder={outputFolder}
          scanning={scanning}
          onSelectInput={handleSelectInputFolder}
          onSelectOutput={handleSelectOutputFolder}
          onScan={handleScan}
        />

        {folders.length > 0 && (
          <>
            <MergeTable
              folders={folders}
              selectedRowKeys={selectedRowKeys}
              onSelectAll={() => setSelectedRowKeys(folders.map((f) => f.key))}
              onClearSelection={() => setSelectedRowKeys([])}
              onHideSelected={handleHideSelected}
              hiddenFolderCount={hiddenFolders.length}
              showHidden={showHidden}
              onToggleHidden={() => setShowHidden(!showHidden)}
              onRowClick={handleRowClick}
              onSelectionChange={setSelectedRowKeys}
              genMergeFileName={genMergeFileName}
            />

            <SubFileList selectedFolder={selectedFolder} />

            {/* 已排除分组面板 */}
            {showHidden && hiddenFolders.length > 0 && (
              <HiddenFoldersPanel
                hiddenFolders={hiddenFolders}
                onRestoreOne={handleRestoreOne}
                onRestoreAll={handleRestoreAll}
              />
            )}

            <MergeActionBar
              processing={processing}
              progress={progress}
              statusText={statusText}
              elapsedSeconds={elapsedSeconds}
              batchProgress={batchProgress}
              folders={folders}
              selectedRowKeys={selectedRowKeys}
              onMerge={handleMerge}
              onOpenDirectory={handleOpenDirectory}
            />
          </>
        )}

        {folders.length === 0 && !scanning && !processing && (
          <Card size="small" style={{ marginTop: 16 }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ color: 'var(--color-text-secondary)' }}>
                  {inputFolder ? '未发现待合并的视频分组，请检查目录或调整设置' : '请选择视频文件所在目录，点击扫描开始'}
                </span>
              }
            />
          </Card>
        )}

        {processing && !folders.length && (
          <Card size="small">
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Text>{statusText || `正在合并... ${formatPercent(progress)}%  已用时 ${formatTime(elapsedSeconds)}`}</Text>
              <Progress percent={parseFloat(progress.toFixed(1))} status="active" format={() => `${formatPercent(progress)}%`} />
            </Space>
          </Card>
        )}
      </Content>

      {/* 设置面板 */}
      <SettingsDrawer
        visible={showSettings}
        onClose={() => setShowSettings(false)}
        config={{
          maxIntervalHours,
          concurrency,
          autoOpenFolder,
          autoOpenWebsite,
          pluginLinkage,
          autoCloseBrowser,
          autoCloseApp,
          runInBackground,
          controlEnabled,
          controlPort,
          controlPassword
        }}
        onSave={(newConfig) => {
          if (newConfig.maxIntervalHours !== undefined) setMaxIntervalHours(newConfig.maxIntervalHours)
          if (newConfig.concurrency !== undefined) setConcurrency(newConfig.concurrency)
          if (newConfig.autoOpenFolder !== undefined) setAutoOpenFolder(newConfig.autoOpenFolder)
          if (newConfig.autoOpenWebsite !== undefined) setAutoOpenWebsite(newConfig.autoOpenWebsite)
          if (newConfig.pluginLinkage !== undefined) setPluginLinkage(newConfig.pluginLinkage)
          if (newConfig.autoCloseBrowser !== undefined) setAutoCloseBrowser(newConfig.autoCloseBrowser)
          if (newConfig.autoCloseApp !== undefined) setAutoCloseApp(newConfig.autoCloseApp)
          if (newConfig.runInBackground !== undefined) setRunInBackground(newConfig.runInBackground)
          if (newConfig.controlEnabled !== undefined) setControlEnabled(newConfig.controlEnabled)
          if (newConfig.controlPort !== undefined) setControlPort(newConfig.controlPort)
          if (newConfig.controlPassword !== undefined) setControlPassword(newConfig.controlPassword)
          if (window.api) {
            window.api.saveConfig(newConfig)
            // 刷新控制地址
            window.api.getControlUrl().then((url) => setControlUrl(url)).catch(() => {})
          }
        }}
        darkMode={darkMode}
      />

      {/* 投稿弹窗 */}
      <UploadModal
        visible={showUploadModal}
        mergedFiles={mergedFiles}
        uploading={uploading}
        selectedKeys={uploadSelectedKeys}
        onClose={() => setShowUploadModal(false)}
        onSelectChange={setUploadSelectedKeys}
        onUpload={handleUpload}
        onLoadFiles={loadMergedFiles}
      />
    </Layout>
  )
}

export default Home
