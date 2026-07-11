import { useState, useReducer, useEffect } from 'react'
import { Drawer, Button, Space, Input, Switch, Typography, Divider, message } from 'antd'

const { Text } = Typography

interface SettingsDrawerProps {
  visible: boolean
  onClose: () => void
  config: AppConfig
  onSave: (config: Partial<AppConfig>) => void
  darkMode: boolean
}

// draft 状态类型
interface DraftConfig {
  maxIntervalHours: number
  concurrency: number
  autoOpenFolder: boolean
  autoOpenWebsite: boolean
  pluginLinkage: boolean
  autoCloseBrowser: boolean
  autoCloseApp: boolean
  runInBackground: boolean
  controlEnabled: boolean
  controlPort: number
  controlPassword: string
}

type DraftAction = { type: 'init'; payload: DraftConfig } | { type: 'update'; key: keyof DraftConfig; value: unknown }

const draftReducer = (state: DraftConfig, action: DraftAction): DraftConfig => {
  switch (action.type) {
    case 'init':
      return { ...action.payload }
    case 'update':
      return { ...state, [action.key]: action.value as any }
    default:
      return state
  }
}

const initialDraft: DraftConfig = {
  maxIntervalHours: 2.5,
  concurrency: 3,
  autoOpenFolder: true,
  autoOpenWebsite: true,
  pluginLinkage: false,
  autoCloseBrowser: false,
  autoCloseApp: true,
  runInBackground: false,
  controlEnabled: true,
  controlPort: 9820,
  controlPassword: ''
}

function SettingsDrawer({ visible, onClose, config, onSave, darkMode: _darkMode }: SettingsDrawerProps): JSX.Element {
  const [draft, dispatchDraft] = useReducer(draftReducer, initialDraft)

  // 网络信息状态
  const [networkIp, setNetworkIp] = useState('')
  const [networkPort, setNetworkPort] = useState(0)

  // 打开时用当前配置初始化 draft 值 + 获取网络信息
  useEffect(() => {
    if (visible) {
      dispatchDraft({
        type: 'init',
        payload: {
          maxIntervalHours: config.maxIntervalHours ?? 2.5,
          concurrency: config.concurrency ?? 3,
          autoOpenFolder: config.autoOpenFolder ?? true,
          autoOpenWebsite: config.autoOpenWebsite ?? true,
          pluginLinkage: config.pluginLinkage ?? false,
          autoCloseBrowser: config.autoCloseBrowser ?? false,
          autoCloseApp: config.autoCloseApp ?? true,
          runInBackground: config.runInBackground ?? false,
          controlEnabled: config.controlEnabled ?? true,
          controlPort: config.controlPort ?? 9820,
          controlPassword: config.controlPassword ?? ''
        }
      })
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
    const newConfig: Partial<AppConfig> = { ...draft }
    onSave(newConfig)
    if (window.api) {
      window.api.toggleControlServer(draft.controlEnabled, draft.controlPort)
    }
    onClose()
    message.success('设置已保存')
  }

  const isNetworkAvailable = networkIp && networkIp !== '0.0.0.0' && networkIp !== '127.0.0.1'

  const descStyle = { fontSize: 13 }

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
            background: 'var(--color-bg-info)',
            border: '1px solid var(--color-border-info)'
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

        {/* ===== 基础设置 ===== */}
        <Space wrap style={{ width: '100%' }}>
          <Space direction="vertical" size={2}>
            <Space>
              <Text>同场直播判定间隔:</Text>
              <Input
                type="number"
                value={draft.maxIntervalHours}
                onChange={(e) => dispatchDraft({ type: 'update', key: 'maxIntervalHours', value: Number(e.target.value) || 2.5 })}
                style={{ width: 80 }}
                min={0.5}
                max={12}
                step={0.5}
              />
              <Text>小时</Text>
            </Space>
            <Text type="secondary" style={descStyle}>超过此间隔视为不同场直播</Text>
          </Space>
          <Space direction="vertical" size={2}>
            <Space>
              <Text>并行合并数:</Text>
              <Input
                type="number"
                value={draft.concurrency}
                onChange={(e) => dispatchDraft({ type: 'update', key: 'concurrency', value: Number(e.target.value) || 3 })}
                style={{ width: 80 }}
                min={1}
                max={8}
                step={1}
              />
              <Text>个</Text>
            </Space>
            <Text type="secondary" style={descStyle}>同时合并的分组数量，建议 2-4</Text>
          </Space>
        </Space>

        {/* ===== 自动化设置 ===== */}
        <Divider orientation="left" style={{ fontSize: 13, color: '#999' }}>自动化</Divider>

        <Space wrap style={{ width: '100%' }}>
          <Text>合并完成后自动打开输出文件夹:</Text>
          <Switch
            checked={draft.autoOpenFolder}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'autoOpenFolder', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary" style={descStyle}>仅首次合并后打开</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>合并完成后自动打开B站投稿页面:</Text>
          <Switch
            checked={draft.autoOpenWebsite}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'autoOpenWebsite', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary" style={descStyle}>仅首次合并后打开</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>B站插件联动（自动上传+投稿）:</Text>
          <Switch
            checked={draft.pluginLinkage}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'pluginLinkage', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary" style={descStyle}>开启后自动传递视频给插件</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>打开B站页面后最小化浏览器:</Text>
          <Switch
            checked={draft.autoCloseBrowser}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'autoCloseBrowser', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary" style={descStyle}>打开投稿页后自动最小化浏览器，不影响其他窗口</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>投稿完成后关闭 App:</Text>
          <Switch
            checked={draft.autoCloseApp}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'autoCloseApp', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary" style={descStyle}>投稿完成后自动退出视频合并工具</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>后台运行:</Text>
          <Switch
            checked={draft.runInBackground}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'runInBackground', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary" style={descStyle}>关闭窗口后最小化到托盘继续运行，手机仍可远程控制</Text>
        </Space>

        {/* ===== 远程控制 ===== */}
        <Divider orientation="left" style={{ fontSize: 13, color: '#999' }}>远程控制</Divider>

        <Space wrap style={{ width: '100%' }}>
          <Text>手机控制面板:</Text>
          <Switch
            checked={draft.controlEnabled}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'controlEnabled', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <Text type="secondary" style={descStyle}>手机在同一 WiFi 下用浏览器访问</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>控制端口:</Text>
          <Input
            type="number"
            value={draft.controlPort}
            onChange={(e) => dispatchDraft({ type: 'update', key: 'controlPort', value: Number(e.target.value) || 9820 })}
            style={{ width: 100 }}
            min={1024}
            max={65535}
            step={1}
          />
          <Text type="secondary" style={descStyle}>默认 9820，修改后需重启 App</Text>
        </Space>
        <Space wrap style={{ width: '100%' }}>
          <Text>控制密码:</Text>
          <Input
            type="text"
            value={draft.controlPassword}
            onChange={(e) => dispatchDraft({ type: 'update', key: 'controlPassword', value: e.target.value })}
            style={{ width: 160 }}
            placeholder="留空则无需密码"
          />
          <Text type="secondary" style={descStyle}>手机访问时需要输入此密码</Text>
        </Space>
      </Space>
    </Drawer>
  )
}

export default SettingsDrawer
