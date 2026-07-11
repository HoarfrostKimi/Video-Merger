import React from 'react'
import { Button, Card, Space, Tag, Typography } from 'antd'
import { UndoOutlined } from '@ant-design/icons'
import { formatSize } from '../utils/format'

const { Text } = Typography

interface HiddenFoldersPanelProps {
  hiddenFolders: FolderGroup[]
  onRestoreOne: (key: string) => void
  onRestoreAll: () => void
}

const HiddenFoldersPanel: React.FC<HiddenFoldersPanelProps> = React.memo(({
  hiddenFolders,
  onRestoreOne,
  onRestoreAll
}) => {
  return (
    <Card
      size="small"
      style={{ marginBottom: 16, border: '1px dashed var(--color-border-card)' }}
      title={
        <Space>
          <Text strong>已排除的分组</Text>
          <Tag color="orange">{hiddenFolders.length} 个</Tag>
        </Space>
      }
      extra={
        <Button size="small" icon={<UndoOutlined />} onClick={onRestoreAll}>
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
              borderBottom: '1px solid var(--color-border-base)'
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
              onClick={() => onRestoreOne(folder.key)}
            >
              恢复
            </Button>
          </div>
        ))}
      </div>
    </Card>
  )
})

HiddenFoldersPanel.displayName = 'HiddenFoldersPanel'

export default HiddenFoldersPanel
