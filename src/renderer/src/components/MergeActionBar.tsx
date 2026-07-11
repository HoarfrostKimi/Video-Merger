import React from 'react'
import { Button, Card, Progress, Space, Typography } from 'antd'
import { FolderOpenOutlined, MergeCellsOutlined } from '@ant-design/icons'
import { formatPercent, formatTime } from '../utils/format'

const { Text } = Typography

interface MergeActionBarProps {
  processing: boolean
  progress: number
  statusText: string
  elapsedSeconds: number
  batchProgress: Record<string, number>
  folders: FolderGroup[]
  selectedRowKeys: React.Key[]
  onMerge: () => void
  onOpenDirectory: () => void
}

const MergeActionBar: React.FC<MergeActionBarProps> = React.memo(({
  processing,
  progress,
  statusText,
  elapsedSeconds,
  batchProgress,
  folders,
  selectedRowKeys,
  onMerge,
  onOpenDirectory
}) => {
  return (
    <Card size="small">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text>{processing ? `${statusText ? statusText + '  ' : ''}${formatPercent(progress)}%  已用时 ${formatTime(elapsedSeconds)}` : `扫描完成 - ${folders.length} 组待合并`}</Text>
        <Space>
          <Button icon={<FolderOpenOutlined />} onClick={onOpenDirectory}>
            打开目录
          </Button>
          <Button
            type="primary"
            icon={<MergeCellsOutlined />}
            onClick={onMerge}
            loading={processing}
            disabled={selectedRowKeys.length === 0}
            size="large"
          >
            {selectedRowKeys.length > 0 ? `一键合并选中视频（${selectedRowKeys.length}个分组）` : '一键合并选中视频'}
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
                const keyStr = String(key)
                const folder = folders.find((f) => f.key === keyStr)
                if (!folder) return null
                const taskProgress = batchProgress[keyStr]
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
  )
})

MergeActionBar.displayName = 'MergeActionBar'

export default MergeActionBar
