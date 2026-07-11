import React from 'react'
import { Card, Button, Input, Space, Typography } from 'antd'
import { FolderOpenOutlined, ScanOutlined } from '@ant-design/icons'

const { Text } = Typography

interface FolderToolbarProps {
  inputFolder: string
  outputFolder: string
  scanning: boolean
  onSelectInput: () => void
  onSelectOutput: () => void
  onScan: () => void
}

const FolderToolbar: React.FC<FolderToolbarProps> = React.memo(({
  inputFolder,
  outputFolder,
  scanning,
  onSelectInput,
  onSelectOutput,
  onScan
}) => {
  return (
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
          <Button icon={<FolderOpenOutlined />} onClick={onSelectInput}>
            浏览...
          </Button>
          <Button type="primary" onClick={onScan} loading={scanning} icon={<ScanOutlined />}>
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
          <Button icon={<FolderOpenOutlined />} onClick={onSelectOutput}>
            浏览...
          </Button>
        </Space>
      </Space>
    </Card>
  )
})

FolderToolbar.displayName = 'FolderToolbar'

export default FolderToolbar
