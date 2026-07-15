import React, { useMemo } from 'react'
import { Button, Modal, Progress, Space, Table, Tag, Typography } from 'antd'
import { UploadOutlined, CheckCircleOutlined, SyncOutlined, CloseCircleOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { formatUploadName, formatTime } from '../utils/format'

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
  uploadElapsed: number
  uploadDone: boolean
  uploadingFileNames: string[]
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
  uploadElapsed,
  uploadDone,
  uploadingFileNames,
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
          <span>{uploading ? '投稿进度' : '待投稿文件'}</span>
          <Tag color="blue">{mergedFiles.length} 个文件</Tag>
        </Space>
      }
      open={visible}
      onCancel={uploading ? undefined : onClose}
      closable={!uploading}
      maskClosable={!uploading}
      width={720}
      footer={
        uploading ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text type="secondary">已用时 {formatTime(uploadElapsed)}</Text>
            {uploadDone && (
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={onClose}>
                完成
              </Button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              <Button size="small" onClick={() => onSelectChange(mergedFiles.map((f) => f.index))}>全选</Button>
              <Button size="small" onClick={() => onSelectChange([])}>取消全选</Button>
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
        )
      }
    >
      {uploading ? (
        <div style={{ padding: '16px 0' }}>
          <div style={{ marginBottom: 16, textAlign: 'center' }}>
            {uploadDone ? (
              <div>
                <CheckCircleOutlined style={{ fontSize: 36, color: '#52c41a' }} />
                <div style={{ marginTop: 8, fontSize: 16, fontWeight: 500 }}>投稿完成！</div>
              </div>
            ) : (
              <div>
                <SyncOutlined spin style={{ fontSize: 36, color: 'var(--color-primary)' }} />
                <div style={{ marginTop: 8, fontSize: 16, fontWeight: 500 }}>B站插件正在投稿...</div>
                <Text type="secondary">请勿关闭B站投稿页面</Text>
              </div>
            )}
          </div>
          <Progress
            percent={uploadDone ? 100 : undefined}
            status={uploadDone ? 'success' : 'active'}
            showInfo={uploadDone}
          />
          {uploadingFileNames.length > 0 && (
            <div style={{ marginTop: 16, maxHeight: 280, overflow: 'auto' }}>
              {uploadingFileNames.map((name, i) => (
                <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {uploadDone
                    ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                    : <SyncOutlined spin style={{ color: 'var(--color-primary)', fontSize: 12 }} />
                  }
                  <Text style={{ fontSize: 13 }}>{i + 1}. {formatUploadName(name)}</Text>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
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
      )}
    </Modal>
  )
})

UploadModal.displayName = 'UploadModal'

export default UploadModal
