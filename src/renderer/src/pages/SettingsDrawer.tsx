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

  const descStyle: React.CSSProperties = { fontSize: 12, marginTop: 2 }
  const sectionTitleStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }
  const settingRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: '1px solid var(--color-border-base)'
  }
  const labelStyle: React.CSSProperties = { fontSize: 14, flex: 1, minWidth: 0, marginRight: 12 }
  const rightStyle: React.CSSProperties = { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }

  return (
    <Drawer
      title={<span style={{ fontSize: 16 }}>⚙️ 设置</span>}
      open={visible}
      onClose={onClose}
      width={440}
      footer={
        <div style={{ textAlign: 'right' }}>
          <Button type="primary" onClick={handleSave} size="large" style={{ paddingLeft: 28, paddingRight: 28 }}>
            保存设置
          </Button>
        </div>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* 局域网访问信息 */}
        <div
          style={{
            padding: '14px 16px',
            borderRadius: 10,
            background: 'var(--color-bg-info)',
            border: '1px solid var(--color-border-info)'
          }}
        >
          <Text strong style={{ display: 'block', marginBottom: 10, fontSize: 14 }}>
            📱 手机局域网访问
          </Text>
          {isNetworkAvailable ? (
            <div>
              <Text copyable style={{ fontSize: 16, color: 'var(--color-success)', fontWeight: 600, wordBreak: 'break-all' }}>
                http://{networkIp}:{networkPort}
              </Text>
              <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                手机连接同一 WiFi 后访问此地址
              </Text>
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 13 }}>未检测到局域网连接，请确认电脑已连接有线网络</Text>
          )}
        </div>

        {/* ===== 基础设置 ===== */}
        <Divider orientation="left" plain style={sectionTitleStyle}>
          基础设置
        </Divider>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>同场直播判定间隔</Text>
          <div style={rightStyle}>
            <Input
              type="number"
              value={draft.maxIntervalHours}
              onChange={(e) => dispatchDraft({ type: 'update', key: 'maxIntervalHours', value: Number(e.target.value) || 2.5 })}
              style={{ width: 72 }}
              min={0.5}
              max={12}
              step={0.5}
              size="small"
            />
            <Text type="secondary" style={{ fontSize: 13 }}>小时</Text>
          </div>
        </div>
        <Text type="secondary" style={{ ...descStyle, marginTop: -4 }}>超过此间隔视为不同场直播</Text>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>并行合并数</Text>
          <div style={rightStyle}>
            <Input
              type="number"
              value={draft.concurrency}
              onChange={(e) => dispatchDraft({ type: 'update', key: 'concurrency', value: Number(e.target.value) || 3 })}
              style={{ width: 72 }}
              min={1}
              max={8}
              step={1}
              size="small"
            />
            <Text type="secondary" style={{ fontSize: 13 }}>个</Text>
          </div>
        </div>
        <Text type="secondary" style={{ ...descStyle, marginTop: -4 }}>同时合并的分组数量，建议 2-4</Text>

        {/* ===== 自动化设置 ===== */}
        <Divider orientation="left" plain style={sectionTitleStyle}>
          自动化
        </Divider>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>合并后自动打开输出文件夹</Text>
          <Switch
            checked={draft.autoOpenFolder}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'autoOpenFolder', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
            size="small"
          />
        </div>
        <Text type="secondary" style={descStyle}>仅首次合并后打开</Text>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>合并后自动打开B站投稿页</Text>
          <Switch
            checked={draft.autoOpenWebsite}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'autoOpenWebsite', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
            size="small"
          />
        </div>
        <Text type="secondary" style={descStyle}>仅首次合并后打开</Text>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>B站插件联动</Text>
          <Switch
            checked={draft.pluginLinkage}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'pluginLinkage', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
            size="small"
          />
        </div>
        <Text type="secondary" style={descStyle}>开启后自动传递视频给插件进行投稿</Text>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>打开B站后最小化浏览器</Text>
          <Switch
            checked={draft.autoCloseBrowser}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'autoCloseBrowser', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
            size="small"
          />
        </div>
        <Text type="secondary" style={descStyle}>自动最小化浏览器窗口，不影响其他工作</Text>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>投稿完成后关闭App</Text>
          <Switch
            checked={draft.autoCloseApp}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'autoCloseApp', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
            size="small"
          />
        </div>
        <Text type="secondary" style={descStyle}>投稿完成后自动退出视频合并工具</Text>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>后台运行</Text>
          <Switch
            checked={draft.runInBackground}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'runInBackground', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
            size="small"
          />
        </div>
        <Text type="secondary" style={descStyle}>关闭窗口后最小化到托盘，手机仍可远程控制</Text>

        {/* ===== 远程控制 ===== */}
        <Divider orientation="left" plain style={sectionTitleStyle}>
          远程控制
        </Divider>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>手机控制面板</Text>
          <Switch
            checked={draft.controlEnabled}
            onChange={(checked) => dispatchDraft({ type: 'update', key: 'controlEnabled', value: checked })}
            checkedChildren="开"
            unCheckedChildren="关"
            size="small"
          />
        </div>
        <Text type="secondary" style={descStyle}>手机在同一 WiFi 下用浏览器访问控制面板</Text>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>控制端口</Text>
          <div style={rightStyle}>
            <Input
              type="number"
              value={draft.controlPort}
              onChange={(e) => dispatchDraft({ type: 'update', key: 'controlPort', value: Number(e.target.value) || 9820 })}
              style={{ width: 90 }}
              min={1024}
              max={65535}
              step={1}
              size="small"
            />
          </div>
        </div>
        <Text type="secondary" style={descStyle}>默认 9820，修改后需重启 App 生效</Text>

        <div style={settingRowStyle}>
          <Text style={labelStyle}>控制密码</Text>
          <Input
            type="text"
            value={draft.controlPassword}
            onChange={(e) => dispatchDraft({ type: 'update', key: 'controlPassword', value: e.target.value })}
            style={{ width: 160 }}
            placeholder="留空则无需密码"
            size="small"
          />
        </div>
        <Text type="secondary" style={descStyle}>手机访问时需要输入此密码，留空则无需密码</Text>
      </Space>
    </Drawer>
  )
}

export default SettingsDrawer
