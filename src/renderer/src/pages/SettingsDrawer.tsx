import { useState, useEffect } from 'react'
import { Drawer, Button, Space, Input, Switch, Typography, message } from 'antd'

const { Text } = Typography

interface SettingsDrawerProps {
  visible: boolean
  onClose: () => void
  config: AppConfig
  onSave: (config: Partial<AppConfig>) => void
  darkMode: boolean
}

function SettingsDrawer({ visible, onClose, config, onSave, darkMode }: SettingsDrawerProps): JSX.Element {
  // 内部 draft 状态：打开时用外部 config 初始化
  const [draftMaxInterval, setDraftMaxInterval] = useState(2.5)
  const [draftConcurrency, setDraftConcurrency] = useState(3)
  const [draftAutoOpenFolder, setDraftAutoOpenFolder] = useState(true)
  const [draftAutoOpenWebsite, setDraftAutoOpenWebsite] = useState(true)
  const [draftPluginLinkage, setDraftPluginLinkage] = useState(false)
  const [draftAutoCloseBrowser, setDraftAutoCloseBrowser] = useState(false)
  const [draftAutoCloseApp, setDraftAutoCloseApp] = useState(true)
  const [draftRunInBackground, setDraftRunInBackground] = useState(false)
  const [draftControlEnabled, setDraftControlEnabled] = useState(true)
  const [draftControlPort, setDraftControlPort] = useState(9820)
  const [draftControlPassword, setDraftControlPassword] = useState('')

  // 网络信息状态
  const [networkIp, setNetworkIp] = useState('')
  const [networkPort, setNetworkPort] = useState(0)

  // 打开时用当前配置初始化 draft 值 + 获取网络信息
  useEffect(() => {
    if (visible) {
      setDraftMaxInterval(config.maxIntervalHours ?? 2.5)
      setDraftConcurrency(config.concurrency ?? 3)
      setDraftAutoOpenFolder(config.autoOpenFolder ?? true)
      setDraftAutoOpenWebsite(config.autoOpenWebsite ?? true)
      setDraftPluginLinkage(config.pluginLinkage ?? false)
      setDraftAutoCloseBrowser(config.autoCloseBrowser ?? false)
      setDraftAutoCloseApp(config.autoCloseApp ?? true)
      setDraftRunInBackground(config.runInBackground ?? false)
      setDraftControlEnabled(config.controlEnabled ?? true)
      setDraftControlPort(config.controlPort ?? 9820)
      setDraftControlPassword(config.controlPassword ?? '')
      fetchNetworkInfo()
    }
  }, [visible, config])

  // 监听 config:updated 时刷新网络信息
  useEffect(() => {
    if (!window.api) return
    const unsubscribe = window.api.onConfigUpdated(() => {
      fetchNetworkInfo()
    })
    return unsubscribe
  }, [])

  const fetchNetworkInfo = async () => {
    if (!window.api) return
    try {
      const info = await window.api.getNetworkInfo()
      setNetworkIp(info.ip || '')
      setNetworkPort(info.port || 0)
    } catch {
      // ignore
    }
  }

  const handleSave = () => {
    const newConfig: Partial<AppConfig> = {
      maxIntervalHours: draftMaxInterval,
      concurrency: draftConcurrency,
      autoOpenFolder: draftAutoOpenFolder,
      autoOpenWebsite: draftAutoOpenWebsite,
      pluginLinkage: draftPluginLinkage,
      autoCloseBrowser: draftAutoCloseBrowser,
      autoCloseApp: draftAutoCloseApp,
      runInBackground: draftRunInBackground,
      controlEnabled: draftControlEnabled,
      controlPort: draftControlPort,
      controlPassword: draftControlPassword
    }
    onSave(newConfig)
    // 启动/停止控制服务器
    if (window.api) {
      window.api.toggleControlServer(draftControlEnabled, draftControlPort)
    }
    onClose()
    message.success('设置已保存')
  }

  const isNetworkAvailable = networkIp && networkIp !== '0.0.0.0' && networkIp !== '127.0.0.1'

  return (
    <Drawer
      title="设置"
      open={visible}
      onClose={onClose}
      width={420}
      footer={
        <div style={{ textAlign: 'right' }}>
          <Button type="primary" onClick={handleSave}>
            保存
          </Button>
        </div>
      }
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* 局域网访问信息 */}
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 8,
            background: darkMode ? '#1f1f1f' : '#f6ffed',
            border: `1px solid ${darkMode ? '#303030' : '#b7eb8f'}`
          }}
        >
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            📱 手机局域网访问
          </Text>
          {isNetworkAvailable ? (
            <Text copyable style={{ fontSize: 15, color: '#52c41a', fontWeight: 500 }}>
              http://{networkIp}:{networkPort}
            </Text>
          ) : (
            <Text type="secondary">未检测到局域网连接，请确认电脑已连接有线网络</Text>
          )}
        </div>

        {/* 第一排：两个数字输入 */}
        <Space wrap style={{ width: '100%' }}>
          <Space direction="vertical" size={2}>
            <Space>
              <Text>同场直播判定间隔:</Text>
              <Input
                type="number"
                value={draftMaxInterval}
                onChange={(e) => setDraftMaxInterval(Number(e.target.value) || 2.5)}
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
                value={draftConcurrency}
                onChange={(e) => setDraftConcurrency(Number(e.target.value) || 3)}
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
            checked={draftAutoOpenFolder}
            onChange={(checked) => setDraftAutoOpenFolder(checked)}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary">（仅首次合并后打开）</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>合并完成后自动打开B站投稿页面:</Text>
          <Switch
            checked={draftAutoOpenWebsite}
            onChange={(checked) => setDraftAutoOpenWebsite(checked)}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary">（仅首次合并后打开）</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>B站插件联动（自动上传+投稿）:</Text>
          <Switch
            checked={draftPluginLinkage}
            onChange={(checked) => setDraftPluginLinkage(checked)}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary">（开启后自动传递视频给插件）</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>打开B站页面后最小化浏览器:</Text>
          <Switch
            checked={draftAutoCloseBrowser}
            onChange={(checked) => setDraftAutoCloseBrowser(checked)}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary">（打开投稿页后自动最小化浏览器，不影响其他窗口）</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>投稿完成后关闭 App:</Text>
          <Switch
            checked={draftAutoCloseApp}
            onChange={(checked) => setDraftAutoCloseApp(checked)}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary">（投稿完成后自动退出视频合并工具）</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>后台运行:</Text>
          <Switch
            checked={draftRunInBackground}
            onChange={(checked) => setDraftRunInBackground(checked)}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary">（关闭窗口后最小化到托盘继续运行，手机仍可远程控制）</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>手机控制面板:</Text>
          <Switch
            checked={draftControlEnabled}
            onChange={(checked) => setDraftControlEnabled(checked)}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary">（手机在同一 WiFi 下用浏览器访问）</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>控制端口:</Text>
          <Input
            type="number"
            value={draftControlPort}
            onChange={(e) => setDraftControlPort(Number(e.target.value) || 9820)}
            style={{ width: 100 }}
            min={1024}
            max={65535}
            step={1}
          />
          <Text type="secondary">（默认 9820，修改后需重启 App）</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>控制密码:</Text>
          <Input
            type="text"
            value={draftControlPassword}
            onChange={(e) => setDraftControlPassword(e.target.value)}
            style={{ width: 160 }}
            placeholder="留空则无需密码"
          />
          <Text type="secondary">（手机访问时需要输入此密码）</Text>
        </Space>
      </Space>
    </Drawer>
  )
}

export default SettingsDrawer
