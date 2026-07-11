import { useState, useEffect, useMemo } from 'react'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import Home from './pages/Home'

function App(): JSX.Element {
  const [darkMode, setDarkMode] = useState(false)

  // 启动时从配置加载主题设置
  useEffect(() => {
    if (!window.api) return
    ;(async () => {
      try {
        const config = await window.api.loadConfig()
        if (config.darkMode !== undefined) {
          setDarkMode(config.darkMode)
          // 初始化原生主题（窗口标题栏）
          window.api.setNativeTheme(config.darkMode)
        }
      } catch {
        // ignore
      }
    })()
  }, [])

  // 主题切换时保存到配置并同步到原生主题
  const handleToggleDarkMode = (value: boolean): void => {
    setDarkMode(value)
    if (window.api) {
      window.api.saveConfig({ darkMode: value })
      window.api.setNativeTheme(value)
    }
  }

  const themeConfig = useMemo(() => ({
    algorithm: darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: '#1677ff',
      borderRadius: 8
    },
    components: {
      Layout: {
        headerBg: darkMode ? '#141414' : '#fff',
        bodyBg: darkMode ? '#141414' : '#f5f5f5'
      }
    }
  }), [darkMode])

  return (
    <div data-theme={darkMode ? 'dark' : 'light'} style={{ height: '100%' }}>
      <ConfigProvider locale={zhCN} theme={themeConfig}>
        <Home darkMode={darkMode} onToggleDarkMode={handleToggleDarkMode} />
      </ConfigProvider>
    </div>
  )
}

export default App
