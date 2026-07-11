import React, { useMemo } from 'react'
import { Button, Card, Space, Table, Tag, Typography } from 'antd'
import { ClearOutlined, EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { formatSize } from '../utils/format'

const { Text } = Typography

interface MergeTableProps {
  folders: FolderGroup[]
  selectedRowKeys: React.Key[]
  onSelectAll: () => void
  onClearSelection: () => void
  onHideSelected: () => void
  hiddenFolderCount: number
  showHidden: boolean
  onToggleHidden: () => void
  onRowClick: (record: FolderGroup) => void
  onSelectionChange: (keys: React.Key[]) => void
  genMergeFileName: (folder: FolderGroup) => string
}

const MergeTable: React.FC<MergeTableProps> = React.memo(({
  folders,
  selectedRowKeys,
  onSelectAll,
  onClearSelection,
  onHideSelected,
  hiddenFolderCount,
  showHidden,
  onToggleHidden,
  onRowClick,
  onSelectionChange,
  genMergeFileName
}) => {
  const columns = useMemo<ColumnsType<FolderGroup>>(() => [
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
      width: 110,
      align: 'center',
      render: (date: string) => <Tag color="blue">{date}</Tag>
    },
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (title: string) => <Text>{title}</Text>
    },
    {
      title: '片段',
      dataIndex: 'fileCount',
      key: 'fileCount',
      width: 80,
      align: 'center',
      render: (count: number) => <Tag color="blue">{count}</Tag>
    },
    {
      title: '类型',
      dataIndex: 'folderName',
      key: 'type',
      width: 100,
      align: 'center',
      render: () => <Tag color="green">原始视频</Tag>
    },
    {
      title: '大小',
      dataIndex: 'totalSize',
      key: 'totalSize',
      width: 120,
      align: 'right',
      render: (size: number) => formatSize(size)
    },
    {
      title: '输出文件',
      dataIndex: 'key',
      key: 'output',
      ellipsis: true,
      render: (_: string, record: FolderGroup) => {
        return <Text type="secondary">{genMergeFileName(record)}.mp4</Text>
      }
    }
  ], [genMergeFileName])

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space>
          <Text strong>待合并视频</Text>
          <Tag color="green">发现 {folders.length} 组待合并，共 {folders.reduce((s, f) => s + f.fileCount, 0)} 个片段</Tag>
        </Space>
      }
      extra={
        <Space>
          <Button size="small" onClick={onSelectAll}>
            全选
          </Button>
          <Button size="small" onClick={onClearSelection} icon={<ClearOutlined />}>
            取消全选
          </Button>
          <Button size="small" danger icon={<EyeInvisibleOutlined />} onClick={onHideSelected}>
            排除选中
          </Button>
          {hiddenFolderCount > 0 && (
            <Button size="small" icon={<EyeOutlined />} onClick={onToggleHidden}>
              查看已排除 ({hiddenFolderCount})
            </Button>
          )}
        </Space>
      }
    >
      <Table
        dataSource={folders}
        columns={columns}
        rowKey="key"
        size="small"
        pagination={false}
        scroll={{ y: 250 }}
        onRow={(record) => ({
          onClick: () => onRowClick(record),
          style: { cursor: 'pointer' }
        })}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => onSelectionChange(keys)
        }}
      />
    </Card>
  )
})

MergeTable.displayName = 'MergeTable'

export default MergeTable
