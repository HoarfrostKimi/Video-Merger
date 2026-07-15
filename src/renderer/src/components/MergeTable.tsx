import React, { useMemo, useState } from 'react'
import { Button, Card, Input, Select, Space, Table, Tag, Typography } from 'antd'
import { ClearOutlined, EyeInvisibleOutlined, EyeOutlined, SearchOutlined } from '@ant-design/icons'
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
  const [searchText, setSearchText] = useState('')
  const [sortBy, setSortBy] = useState<string>('date:desc')

  const filteredFolders = useMemo(() => {
    let list = folders
    if (searchText.trim()) {
      const kw = searchText.trim().toLowerCase()
      list = list.filter(f => f.title.toLowerCase().includes(kw) || f.date.includes(kw))
    }
    const [field, order] = sortBy.split(':')
    return [...list].sort((a, b) => {
      let cmp = 0
      if (field === 'date') cmp = a.date.localeCompare(b.date)
      else if (field === 'title') cmp = a.title.localeCompare(b.title)
      else if (field === 'fileCount') cmp = a.fileCount - b.fileCount
      else if (field === 'totalSize') cmp = a.totalSize - b.totalSize
      return order === 'desc' ? -cmp : cmp
    })
  }, [folders, searchText, sortBy])
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
      style={{ marginBottom: 16, borderRadius: 10 }}
      title={
        <Space>
          <Text strong style={{ fontSize: 14 }}>待合并视频</Text>
          <Tag color="green">发现 {folders.length} 组待合并，共 {folders.reduce((s, f) => s + f.fileCount, 0)} 个片段</Tag>
        </Space>
      }
      extra={
        <Space size={4} wrap>
          <Input
            size="small"
            placeholder="搜索标题/日期..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            style={{ width: 160 }}
          />
          <Select
            size="small"
            value={sortBy}
            onChange={setSortBy}
            style={{ width: 130 }}
            options={[
              { value: 'date:desc', label: '日期 ↓' },
              { value: 'date:asc', label: '日期 ↑' },
              { value: 'title:asc', label: '标题 A-Z' },
              { value: 'title:desc', label: '标题 Z-A' },
              { value: 'fileCount:desc', label: '片段数 ↓' },
              { value: 'totalSize:desc', label: '大小 ↓' },
            ]}
          />
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
        dataSource={filteredFolders}
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
