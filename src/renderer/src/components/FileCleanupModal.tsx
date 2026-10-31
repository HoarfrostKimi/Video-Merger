import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Collapse, Empty, List, message, Modal, Space, Tabs, Tag, Typography } from 'antd'
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import { formatSize, formatUploadName } from '../utils/format'

const { Text } = Typography

interface FileCleanupModalProps {
  open: boolean
  onClose: () => void
  /** 删除完成后回调（让主界面刷新分组和投稿列表） */
  onDeleted: () => void
}

/** 按「日期 + 标题」聚合的一场直播 */
interface FileGroup {
  key: string
  date: string
  title: string
  files: CleanupFileItem[]
  totalSize: number
}

/** 把平铺文件列表按场次聚合（优先用主进程打的 sessionKey，跨天直播也能归到同一场） */
function groupBySession(items: CleanupFileItem[]): FileGroup[] {
  const map = new Map<string, FileGroup>()
  for (const item of items) {
    const k = item.sessionKey || `${item.date}|${item.title}`
    const g = map.get(k)
    if (g) {
      g.files.push(item)
      g.totalSize += item.size
    } else {
      map.set(k, { key: k, date: item.date, title: item.title, files: [item], totalSize: item.size })
    }
  }
  return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title))
}

/**
 * 清理文件面板：原文件与已合并文件按「一场直播」分组展示，
 * 整场勾选、一键删除（移至回收站）。
 */
const FileCleanupModal: React.FC<FileCleanupModalProps> = ({ open, onClose, onDeleted }) => {
  const [segments, setSegments] = useState<CleanupFileItem[]>([])
  const [merged, setMerged] = useState<CleanupFileItem[]>([])
  const [activeTab, setActiveTab] = useState<string>('segments')
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [segSelected, setSegSelected] = useState<Set<string>>(new Set())
  const [mergedSelected, setMergedSelected] = useState<Set<string>>(new Set())

  const segmentGroups = useMemo(() => groupBySession(segments), [segments])
  const mergedGroups = useMemo(() => groupBySession(merged), [merged])

  const load = useCallback(async () => {
    if (!window.api) return
    setLoading(true)
    try {
      const data = await window.api.listAllFiles()
      setSegments(data.segments)
      setMerged(data.merged)
      setSegSelected(new Set())
      setMergedSelected(new Set())
    } catch (e: any) {
      message.error(e.message || '加载文件列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const isSegTab = activeTab === 'segments'
  const activeGroups = isSegTab ? segmentGroups : mergedGroups
  const activeSelected = isSegTab ? segSelected : mergedSelected
  const activeSetter = isSegTab ? setSegSelected : setMergedSelected

  /** 切换一场直播的整组选中状态 */
  const toggleGroup = (group: FileGroup) => {
    const next = new Set(activeSelected)
    const allChecked = group.files.every((f) => next.has(f.path))
    for (const f of group.files) {
      if (allChecked) next.delete(f.path)
      else next.add(f.path)
    }
    activeSetter(next)
  }

  const toggleAll = () => {
    const allPaths = activeGroups.flatMap((g) => g.files.map((f) => f.path))
    const allChecked = allPaths.length > 0 && allPaths.every((p) => activeSelected.has(p))
    activeSetter(allChecked ? new Set() : new Set(allPaths))
  }

  const handleDelete = () => {
    const paths = Array.from(activeSelected)
    if (paths.length === 0) return
    const label = isSegTab ? '原始分段文件' : '已合并 MP4'
    Modal.confirm({
      title: `确认删除 ${paths.length} 个${label}？`,
      content: '文件将移至回收站，删除后不可恢复。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setDeleting(true)
        try {
          const res = await window.api!.deleteFiles(paths)
          message.success(`已删除 ${res.deleted} 个文件${res.failed.length > 0 ? `，${res.failed.length} 个失败` : ''}`)
          await load()
          onDeleted()
        } catch (e: any) {
          message.error(e.message || '删除失败')
        } finally {
          setDeleting(false)
        }
      }
    })
  }

  const renderFileRow = (item: CleanupFileItem, selected: Set<string>) => (
    <List.Item key={item.path} style={{ padding: '4px 0' }}>
      <Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 0 }} ellipsis>
        {item.name}
      </Text>
      <Text type="secondary" style={{ fontSize: 12, marginLeft: 8, flexShrink: 0 }}>{formatSize(item.size)}</Text>
    </List.Item>
  )

  const renderGroupList = (groups: FileGroup[], selected: Set<string>) =>
    groups.length === 0 ? (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isSegTab ? '暂无分段文件' : '暂无已合并文件'} />
    ) : (
      <Collapse
        ghost
        size="small"
        items={groups.map((g) => ({
          key: g.key,
          label: (
            <Space size={8} style={{ width: '100%' }} onClick={(e) => e.stopPropagation()}>
              <Checkbox
                checked={g.files.every((f) => selected.has(f.path))}
                indeterminate={g.files.some((f) => selected.has(f.path)) && !g.files.every((f) => selected.has(f.path))}
                onChange={() => toggleGroup(g)}
              />
              <Tag color="blue" style={{ marginRight: 0 }}>{g.date}</Tag>
              <Text strong style={{ fontSize: 13 }} ellipsis>{g.title}</Text>
              <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                {g.files.length} 个文件 · {formatSize(g.totalSize)}
              </Text>
            </Space>
          ),
          children: (
            <div style={{ paddingLeft: 28 }}>
              <List size="small" dataSource={g.files} renderItem={(f) => renderFileRow(f, selected)} />
            </div>
          )
        }))}
      />
    )

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="清理文件"
      width={760}
      footer={[
        <Button key="reload" icon={<ReloadOutlined />} onClick={load} disabled={loading}>
          刷新
        </Button>,
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button
          key="delete"
          danger
          type="primary"
          icon={<DeleteOutlined />}
          onClick={handleDelete}
          loading={deleting}
          disabled={activeSelected.size === 0}
        >
          删除选中{isSegTab ? '原文件' : '已合并文件'}（{activeSelected.size}）
        </Button>
      ]}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="删除功能集中在这里。文件按「一场直播」分组，勾选整场即可删除（移至回收站），点击场次可查看该场的分段明细。"
      />
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'segments',
            label: <span>原文件 <Tag>{segmentGroups.length} 场</Tag></span>,
            children: (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    共 {segments.length} 个分段文件，按直播场次聚合；删除后该场直播无法再合并
                  </Text>
                  <Button type="link" size="small" style={{ padding: 0 }} onClick={toggleAll}>
                    {segments.length > 0 && segSelected.size === segments.length ? '取消全选' : '全选'}
                  </Button>
                </div>
                <div style={{ maxHeight: 420, overflowY: 'auto' }}>{renderGroupList(segmentGroups, segSelected)}</div>
              </div>
            )
          },
          {
            key: 'merged',
            label: <span>已合并文件 <Tag color="green">{mergedGroups.length} 场</Tag></span>,
            children: (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    共 {merged.length} 个合并 MP4；删除后不影响原始分段文件
                  </Text>
                  <Button type="link" size="small" style={{ padding: 0 }} onClick={toggleAll}>
                    {merged.length > 0 && mergedSelected.size === merged.length ? '取消全选' : '全选'}
                  </Button>
                </div>
                <div style={{ maxHeight: 420, overflowY: 'auto' }}>{renderGroupList(mergedGroups, mergedSelected)}</div>
              </div>
            )
          }
        ]}
      />
    </Modal>
  )
}

export default FileCleanupModal
