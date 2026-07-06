import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import Home from './pages/Home'

function App(): JSX.Element {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 8
        }
      }}
    >
      <Home />
    </ConfigProvider>
  )
}

export default App
