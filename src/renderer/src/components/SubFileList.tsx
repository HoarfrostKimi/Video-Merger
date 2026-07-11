import React from 'react'
import { Card, Typography } from 'antd'
import { formatSize } from '../utils/format'

const { Text } = Typography

interface SubFileListProps {
  selectedFolder: FolderGroup | null
}

const SubFileList: React.FC<SubFileListProps> = React.memo(({ selectedFolder }) => {
  return (
    <Card
      size="small"
      style={{ marginBottom: 16, borderRadius: 10 }}
      title={<Text strong style={{ fontSize: 14 }}>选中任务的子文件列表</Text>}
    >
      {selectedFolder ? (
        <div style={{ maxHeight: 150, overflowY: 'auto' }}>
          <Text type="secondary">共 {selectedFolder.fileCount} 个片段，合计 {formatSize(selectedFolder.totalSize)}:</Text>
          <div style={{ marginTop: 8 }}>
            {selectedFolder.files.map((file, index) => (
              <div key={file.path} style={{ padding: '4px 0', borderBottom: '1px solid var(--color-border-base)' }}>
                <Text>{index + 1}.</Text>
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
  )
})

SubFileList.displayName = 'SubFileList'

export default SubFileList
