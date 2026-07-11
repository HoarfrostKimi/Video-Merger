import React, { useMemo } from 'react'
import { Button, Modal, Space, Table, Tag, Typography } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { formatUploadName } from '../utils/format'

const { Text } = Typography

interface MergedFile {
  index: number
  name: string
  path: string
  mtime: number
}

interface UploadModalProps {
  visible: boolean
  mergedFiles: MergedFile[]
  uploading: boolean
  selectedKeys: React.Key[]
  onClose: () => void
  onSelectChange: (keys: React.Key[]) => void
  onUpload: (selectedPaths: string[]) => Promise<void>
  onLoadFiles: () => void
}

const UploadModal: React.FC<UploadModalProps> = React.memo(({
  visible,
  mergedFiles,
  uploading,
  selectedKeys,
  onClose,
  onSelectChange,
  onUpload
}) => {
  const columns = useMemo<ColumnsType<MergedFile>>(() => [
    {
      title: '#',
      key: 'no',
      width: 50,
      align: 'center',
      render: (_: unknown, __: unknown, index: number) => index + 1
    },
    {
      title: '文件名',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string) => <Text>{formatUploadName(name)}</Text>
    },
    {
      title: '修改时间',
      dataIndex: 'mtime',
      key: 'mtime',
      width: 150,
      align: 'center',
      render: (mtime: number) => {
        const d = new Date(mtime)
        const pad = (n: number) => String(n).padStart(2, '0')
        return <Text type="secondary">{d.getFullYear()}-{pad(d.getMonth() + 1)}-{pad(d.getDate())} {pad(d.getHours())}:{pad(d.getMinutes())}</Text>
      }
    },
    {
      title: '路径',
      dataIndex: 'path',
      key: 'path',
      ellipsis: true,
      render: (path: string) => <Text type="secondary" style={{ fontSize: 12 }}>{path}</Text>
    }
  ], [])

  return (
    <Modal
      title={
        <Space>
          <UploadOutlined style={{ color: 'var(--color-primary)' }} />
          <span>待投稿文件</span>
          <Tag color="blue">{mergedFiles.length} 个文件</Tag>
        </Space>
      }
      open={visible}
      onCancel={onClose}
      width={720}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Button
              size="small"
              onClick={() => onSelectChange(mergedFiles.map((f) => f.index))}
            >
              全选
            </Button>
            <Button
              size="small"
              onClick={() => onSelectChange([])}
            >
              取消全选
            </Button>
          </Space>
          <Space>
            <Button onClick={onClose}>关闭</Button>
            <Button
              type="primary"
              icon={<UploadOutlined />}
              loading={uploading}
              disabled={selectedKeys.length === 0}
              onClick={async () => {
                const selectedPaths = mergedFiles
                  .filter((f) => selectedKeys.includes(f.index))
                  .map((f) => f.path)
                await onUpload(selectedPaths)
              }}
            >
              投稿选中文件
            </Button>
          </Space>
        </div>
      }
    >
      <Table
        dataSource={mergedFiles}
        rowKey="index"
        size="small"
        pagination={false}
        scroll={{ y: 400 }}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: (keys) => onSelectChange(keys)
        }}
        columns={columns}
        locale={{ emptyText: <span style={{ color: 'var(--color-text-secondary)' }}>暂无已合并文件，请先合并视频</span> }}
      />
    </Modal>
  )
})

UploadModal.displayName = 'UploadModal'

export default UploadModal
