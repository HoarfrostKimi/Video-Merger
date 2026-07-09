import { useState, useEffect, useCallback, useRef } from 'react'
import { Layout, Card, Button, Table, Progress, Space, Tag, message, Typography, Input, Switch, Drawer } from 'antd'
import { FolderOpenOutlined, ScanOutlined, MergeCellsOutlined, ClearOutlined, BulbOutlined, BulbFilled, EyeInvisibleOutlined, EyeOutlined, UndoOutlined, SettingOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'

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
  const [showSettings, setShowSettings] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const websiteOpenedRef = useRef(false)
  const folderOpenedRef = useRef(false)

  useEffect(() => {
    if (!window.api) return
    ;(async () => {
      try {
        const config = await window.api.loadConfig()
        if (config.inputFolder) {
          setInputFolder(config.inputFolder)
        }
        if (config.outputFolder) {
          setOutputFolder(config.outputFolder)
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
      } catch (err) {
        console.warn('加载配置失败:', err)
      }
    })()
  }, [])

  // 启动时如果已有输入文件夹，自动扫描
  useEffect(() => {
    if (!inputFolder || !window.api) return
    ;(async () => {
      try {
        setScanning(true)
        const result: ScanResult = await window.api.scanFlvFiles(inputFolder, maxIntervalHours)
        setFolders(result.folders)
        const totalFiles = result.folders.reduce((s, g) => s + g.fileCount, 0)
        if (totalFiles > 0) {
          message.success(`自动扫描完成，找到 ${result.folders.length} 组待合并，共 ${totalFiles} 个片段`)
        }
      } catch {
        // ignore
      } finally {
        setScanning(false)
      }
    })()
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
      const result: ScanResult = await window.api.scanFlvFiles(inputFolder, maxIntervalHours)
      // 过滤掉已排除的分组（按标题+日期匹配）
      const hiddenKeys = new Set(hiddenFolders.map((f) => f.key))
      const filtered = result.folders.filter((f) => !hiddenKeys.has(f.key))
      setFolders(filtered)
      setSelectedRowKeys([])
      setSelectedFolder(null)
      const totalFiles = filtered.reduce((s, g) => s + g.fileCount, 0)
      message.success(`扫描完成，找到 ${filtered.length} 组待合并，共 ${totalFiles} 个片段`)
    } catch (err: any) {
      message.error(err.message || '扫描失败')
    } finally {
      setScanning(false)
    }
  }, [inputFolder, hiddenFolders])

  // 格式化百分比：小于 1% 时显示一位小数，否则显示整数
  const formatPercent = (p: number) => {
    if (p <= 0) return '0'
    if (p < 1) return p.toFixed(1)
    return p.toFixed(0)
  }

  // 格式化秒数为 mm:ss 或 hh:mm:ss
  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    return `${m}:${String(sec).padStart(2, '0')}`
  }

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

    // 启动计时器，每秒更新已用时间
    timerRef.current = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1)
    }, 1000)

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

    // 启动进度轮询，每 500ms 从主进程获取批量进度
    const pollInterval = setInterval(async () => {
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
    }, 500)

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
      setSelectedRowKeys((prev) => prev.filter((k) => !successKeys.includes(k)))

      setProgress(100)
      setStatusText('')

      // 合并完成后自动打开输出文件夹和B站投稿页面（仅首次）
      if (successCount > 0 && window.api && outputFolder) {
        try {
          if (autoOpenFolder && !folderOpenedRef.current) {
            await window.api.openDirectory(outputFolder)
            folderOpenedRef.current = true
          }
          // 根据开关状态和是否已打开过来决定是否打开网站
          if (autoOpenWebsite && !websiteOpenedRef.current) {
            await window.api.openExternal('https://member.bilibili.com/platform/upload/video/frame')
            websiteOpenedRef.current = true
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
      clearInterval(pollInterval)
      if (timerRef.current) clearInterval(timerRef.current)
      setProcessing(false)
    }
  }, [selectedRowKeys, folders, outputFolder, genMergeFileName, concurrency])

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
    setHiddenFolders((prev) => [...prev, ...toHide])
    setFolders((prev) => prev.filter((f) => !selectedRowKeys.includes(f.key)))
    setSelectedRowKeys([])
    setSelectedFolder(null)
    message.success(`已排除 ${toHide.length} 个分组`)
  }, [selectedRowKeys, folders])

  // 恢复单个隐藏分组
  const handleRestoreOne = useCallback((key: string) => {
    const folder = hiddenFolders.find((f) => f.key === key)
    if (!folder) return
    setHiddenFolders((prev) => prev.filter((f) => f.key !== key))
    setFolders((prev) => [...prev, folder])
    message.success(`已恢复：${folder.folderName}`)
  }, [hiddenFolders])

  // 恢复所有隐藏分组
  const handleRestoreAll = useCallback(() => {
    setFolders((prev) => [...prev, ...hiddenFolders])
    setHiddenFolders([])
    setShowHidden(false)
    message.success(`已恢复全部 ${hiddenFolders.length} 个分组`)
  }, [hiddenFolders])

  const formatSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  const handleRowClick = (record: FolderGroup) => {
    setSelectedFolder(record)
  }

  const columns: ColumnsType<FolderGroup> = [
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
      width: 110,
      align: 'center',
      render: (date: string) => <Tag color="blue">{date}</Tag>
    },
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (title: string) => <Text>{title}</Text>
    },
    {
      title: '片段',
      dataIndex: 'fileCount',
      key: 'fileCount',
      width: 80,
      align: 'center',
      render: (count: number) => <Tag color="blue">{count}</Tag>
    },
    {
      title: '类型',
      dataIndex: 'folderName',
      key: 'type',
      width: 100,
      align: 'center',
      render: () => <Tag color="green">原始视频</Tag>
    },
    {
      title: '大小',
      dataIndex: 'totalSize',
      key: 'totalSize',
      width: 120,
      align: 'right',
      render: (size: number) => formatSize(size)
    },
    {
      title: '输出文件',
      dataIndex: 'key',
      key: 'output',
      ellipsis: true,
      render: (_: string, record: FolderGroup) => {
        return <Text type="secondary">{genMergeFileName(record)}.mp4</Text>
      }
    }
  ]

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          background: darkMode ? '#141414' : '#fff',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          borderBottom: darkMode ? '1px solid #303030' : '1px solid #f0f0f0'
        }}
      >
        <Title level={3} style={{ margin: 0 }}>
          <MergeCellsOutlined /> 视频自动合并工具
        </Title>
        <Tag color="green" style={{ marginLeft: 16 }}>FFmpeg 就绪</Tag>
        <div style={{ flex: 1 }} />
        <Button
          icon={<SettingOutlined />}
          onClick={() => setShowSettings(true)}
          title="设置"
        />
        <Button
          icon={darkMode ? <BulbFilled /> : <BulbOutlined />}
          onClick={() => onToggleDarkMode(!darkMode)}
          title={darkMode ? '切换到浅色模式' : '切换到深色模式'}
        >
          {darkMode ? '深色' : '浅色'}
        </Button>
      </Header>

      <Content style={{ padding: 24 }}>
        <Card size="small" style={{ marginBottom: 16 }}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Text strong>输入目录（扫描视频文件）</Text>
            <Space wrap>
              <Input
                value={inputFolder}
                readOnly
                style={{ flex: 1, minWidth: 400 }}
                placeholder="请选择文件夹"
              />
              <Button icon={<FolderOpenOutlined />} onClick={handleSelectInputFolder}>
                浏览...
              </Button>
              <Button onClick={handleScan} loading={scanning} icon={<ScanOutlined />}>
                扫描视频
              </Button>
            </Space>
            <Text strong>输出目录（保存合并后的MP4）</Text>
            <Space wrap>
              <Input
                value={outputFolder}
                readOnly
                style={{ flex: 1, minWidth: 400 }}
                placeholder="请选择输出文件夹"
              />
              <Button icon={<FolderOpenOutlined />} onClick={handleSelectOutputFolder}>
                浏览...
              </Button>
            </Space>
          </Space>
        </Card>

        {folders.length > 0 && (
          <>
            <Card
              size="small"
              style={{ marginBottom: 16 }}
              title={
                <Space>
                  <Text strong>待合并视频</Text>
                  <Tag color="green">发现 {folders.length} 组待合并，共 {folders.reduce((s, f) => s + f.fileCount, 0)} 个片段</Tag>
                </Space>
              }
              extra={
                <Space>
                  <Button size="small" onClick={() => setSelectedRowKeys(folders.map((f) => f.key))}>
                    全选
                  </Button>
                  <Button size="small" onClick={() => setSelectedRowKeys([])} icon={<ClearOutlined />}>
                    取消全选
                  </Button>
                  <Button size="small" danger icon={<EyeInvisibleOutlined />} onClick={handleHideSelected}>
                    排除选中
                  </Button>
                  {hiddenFolders.length > 0 && (
                    <Button size="small" icon={<EyeOutlined />} onClick={() => setShowHidden(!showHidden)}>
                      查看已排除 ({hiddenFolders.length})
                    </Button>
                  )}
                </Space>
              }
            >
              <Table
                dataSource={folders}
                columns={columns}
                rowKey="key"
                size="small"
                pagination={false}
                scroll={{ y: 250 }}
                onRow={(record) => ({
                  onClick: () => handleRowClick(record)
                })}
                rowSelection={{
                  selectedRowKeys,
                  onChange: (keys) => setSelectedRowKeys(keys)
                }}
              />
            </Card>

            <Card
              size="small"
              style={{ marginBottom: 16 }}
              title={<Text strong>选中任务的子文件列表</Text>}
            >
              {selectedFolder ? (
                <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                  <Text type="secondary">共 {selectedFolder.fileCount} 个片段，合计 {formatSize(selectedFolder.totalSize)}:</Text>
                  <div style={{ marginTop: 8 }}>
                    {selectedFolder.files.map((file, index) => (
                      <div key={file.path} style={{ padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
                        <Text type="primary">{index + 1}.</Text>
                        <Text style={{ marginLeft: 8 }}>{file.name}</Text>
                        <Text type="secondary" style={{ marginLeft: 12 }}>({formatSize(file.size)})</Text>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <Text type="secondary">请选择一个文件夹查看子文件列表</Text>
              )}
            </Card>

            {/* 已排除分组面板 */}
            {showHidden && hiddenFolders.length > 0 && (
              <Card
                size="small"
                style={{ marginBottom: 16, border: '1px dashed #d9d9d9' }}
                title={
                  <Space>
                    <Text strong>已排除的分组</Text>
                    <Tag color="orange">{hiddenFolders.length} 个</Tag>
                  </Space>
                }
                extra={
                  <Button size="small" icon={<UndoOutlined />} onClick={handleRestoreAll}>
                    全部恢复
                  </Button>
                }
              >
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {hiddenFolders.map((folder) => (
                    <div
                      key={folder.key}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 12px',
                        borderBottom: '1px solid #f0f0f0'
                      }}
                    >
                      <Space>
                        <Tag color="orange">{folder.date}</Tag>
                        <Text>{folder.folderName}</Text>
                        <Text type="secondary">({folder.fileCount}个片段, {formatSize(folder.totalSize)})</Text>
                      </Space>
                      <Button
                        size="small"
                        icon={<UndoOutlined />}
                        onClick={() => handleRestoreOne(folder.key)}
                      >
                        恢复
                      </Button>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card size="small">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text>{processing ? `${statusText ? statusText + '  ' : ''}${formatPercent(progress)}%  已用时 ${formatTime(elapsedSeconds)}` : `扫描完成 - ${folders.length} 组待合并`}</Text>
                <Space>
                  <Button icon={<FolderOpenOutlined />} onClick={handleOpenDirectory}>
                    打开目录
                  </Button>
                  <Button
                    type="primary"
                    icon={<MergeCellsOutlined />}
                    onClick={handleMerge}
                    loading={processing}
                    disabled={selectedRowKeys.length === 0}
                    size="large"
                  >
                    一键合并选中视频
                  </Button>
                </Space>
              </div>
              {processing && (
                <div style={{ marginTop: 12 }}>
                  <Progress percent={parseFloat(progress.toFixed(1))} status="active" format={() => `${formatPercent(progress)}%`} />
                  {/* 显示每个任务的进度 */}
                  {Object.keys(batchProgress).length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      {selectedRowKeys.map((key) => {
                        const folder = folders.find((f) => f.key === key)
                        if (!folder) return null
                        const taskProgress = batchProgress[key]
                        if (taskProgress === undefined) return null

                        const status = taskProgress === 100 ? 'success' : taskProgress === -1 ? 'exception' : 'active'
                        const percent = taskProgress === -1 ? 0 : taskProgress

                        return (
                          <div key={key} style={{ marginBottom: 8 }}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {folder.folderName}
                            </Text>
                            <Progress
                              percent={parseFloat(percent.toFixed(1))}
                              status={status}
                              size="small"
                              format={() => taskProgress === -1 ? '失败' : `${formatPercent(percent)}%`}
                            />
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </>
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
      <Drawer
        title="设置"
        open={showSettings}
        onClose={() => setShowSettings(false)}
        width={420}
      >
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* 第一排：两个数字输入 */}
          <Space wrap style={{ width: '100%' }}>
            <Space direction="vertical" size={2}>
              <Space>
                <Text>同场直播判定间隔:</Text>
                <Input
                  type="number"
                  value={maxIntervalHours}
                  onChange={(e) => setMaxIntervalHours(Number(e.target.value) || 2.5)}
                  style={{ width: 80 }}
                  min={0.5}
                  max={12}
                  step={0.5}
                />
                <Text>小时</Text>
              </Space>
              <Text type="secondary">（超过此间隔视为不同场直播）</Text>
            </Space>
            <Space direction="vertical" size={2}>
              <Space>
                <Text>并行合并数:</Text>
                <Input
                  type="number"
                  value={concurrency}
                  onChange={(e) => {
                    const val = Number(e.target.value) || 3
                    setConcurrency(val)
                    if (window.api) window.api.saveConfig({ concurrency: val })
                  }}
                  style={{ width: 80 }}
                  min={1}
                  max={8}
                  step={1}
                />
                <Text>个</Text>
              </Space>
              <Text type="secondary">（同时合并的分组数量，建议2-4）</Text>
            </Space>
          </Space>
          <Space wrap style={{ width: '100%' }}>
            <Text>合并完成后自动打开输出文件夹:</Text>
            <Switch
              checked={autoOpenFolder}
              onChange={(checked) => {
                setAutoOpenFolder(checked)
                if (window.api) window.api.saveConfig({ autoOpenFolder: checked })
              }}
              checkedChildren="开"
              unCheckedChildren="关"
            />
            <Text type="secondary">（仅首次合并后打开）</Text>
          </Space>
          <Space wrap style={{ width: '100%' }}>
            <Text>合并完成后自动打开B站投稿页面:</Text>
            <Switch
              checked={autoOpenWebsite}
              onChange={(checked) => {
                setAutoOpenWebsite(checked)
                if (window.api) window.api.saveConfig({ autoOpenWebsite: checked })
              }}
              checkedChildren="开"
              unCheckedChildren="关"
            />
            <Text type="secondary">（仅首次合并后打开）</Text>
          </Space>
        </Space>
      </Drawer>
    </Layout>
  )
}

export default Home