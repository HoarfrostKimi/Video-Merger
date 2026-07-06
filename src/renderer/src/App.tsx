import { useState, useEffect } from 'react'
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
        }
      } catch {
        // ignore
      }
    })()
  }, [])

  // 主题切换时保存到配置
  const handleToggleDarkMode = (value: boolean): void => {
    setDarkMode(value)
    if (window.api) {
      window.api.saveConfig({ darkMode: value })
    }
  }

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: darkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 8
        }
      }}
    >
      <Home darkMode={darkMode} onToggleDarkMode={handleToggleDarkMode} />
    </ConfigProvider>
  )
}

export default App
