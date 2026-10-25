import { useEffect, useRef, useState } from 'react';
import { ArchiveRestore, CheckCircle2, Database, FolderArchive } from 'lucide-react';
import type { AriadneApi } from '@shared/contract';
import type { DataRestorePreview, DataUsageView, DataCleanupPreview, DataCleanupCategory } from '@shared/data-management';
import { ConfirmDialog } from '@renderer/shared/ui/ActionDialog';
import './data-management-settings.css';

export function DataManagementSettings({ api }: { api: AriadneApi['dataManagement'] }): React.JSX.Element {
  const [operation, setOperation] = useState<'backup' | 'inspect' | 'discard' | 'restore' | 'usage' | 'cleanup-inspect' | 'cleanup-discard' | 'cleanup-commit' | null>(null);
  const [usage, setUsage] = useState<DataUsageView | null>(null);
  const [preview, setPreview] = useState<DataRestorePreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cleanup, setCleanup] = useState<DataCleanupPreview | null>(null);
  const [cleanupSelected, setCleanupSelected] = useState<DataCleanupCategory[]>([]);
  const [cleanupConfirming, setCleanupConfirming] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const mounted = useRef(false), running = useRef(false), retainedPreview = useRef<DataRestorePreview | null>(null);
  const retainedCleanup = useRef<DataCleanupPreview | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const owned = retainedPreview.current; retainedPreview.current = null;
      if (owned) void api.discardRestore({ ticket: owned.ticket }).catch(() => undefined);
      const cleanupOwned = retainedCleanup.current; retainedCleanup.current = null;
      if (cleanupOwned) void api.discardCleanup({ ticket: cleanupOwned.ticket }).catch(() => undefined);
    };
  }, [api]);
  const start = (kind: NonNullable<typeof operation>, action: () => Promise<void>, failure: string): void => {
    if (running.current) return;
    running.current = true; setOperation(kind); setNotice(null);
    void action().catch(() => { if (mounted.current) setNotice({ error: true, text: failure }); }).finally(() => {
      running.current = false; if (mounted.current) setOperation(null);
    });
  };
  const discard = (): void => {
    if (!preview) return; const selected = preview;
    start('discard', async () => {
      await api.discardRestore({ ticket: selected.ticket }); retainedPreview.current = null;
      if (mounted.current) setPreview(null);
    }, '未能释放恢复预览，请稍后重试。');
  };
  const disabled = operation !== null || preview !== null || cleanup !== null;
  const cleanupFiles = cleanup ? (cleanupSelected.includes('orphan-attachment') ? cleanup.orphanObjects : 0)
    + (cleanupSelected.includes('unpublished-attachment') ? cleanup.unpublishedObjects : 0) : 0;
  const cleanupBytes = cleanup ? (cleanupSelected.includes('orphan-attachment') ? cleanup.orphanBytes : 0)
    + (cleanupSelected.includes('unpublished-attachment') ? cleanup.unpublishedBytes : 0) : 0;
  return <section className="settings-section data-management-settings" aria-label="数据备份与恢复">
    <div className="settings-section-heading"><div className="settings-section-title"><span className="settings-section-icon"><Database size={16} /></span>
      <div className="settings-section-copy"><h2>数据备份与恢复</h2><p>备份保存一份独立副本；归档只隐藏项目，数据仍留在当前目录。</p></div></div></div>
    <div className="data-management-scope">
      <strong>本机当前 Windows 账户</strong>
      <p>包括会话与消息附件、设置、未发送草稿、运行恢复记录及加密凭据。模型权重与工作区原文件不包含在内。</p>
      <p>仅支持当前系统格式。备份不能作为跨机器或跨账户迁移文件。</p>
    </div>
    <div className="setting-block"><div><strong>数据占用</strong><p>统计应用数据库、消息图像和私有数据文件的逻辑大小，包括数据库日志。数值是当前采样，未包含模型、工作区文件或保留的恢复目录。</p></div>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => start('usage', async () => {
        const result = await api.measureUsage(); if (mounted.current) setUsage(result);
      }, '未能完整统计数据占用，请稍后重试。')}>{operation === 'usage' ? '正在统计…' : '刷新占用'}</button></div>
    {usage && <div className="data-restore-preview" aria-label="数据占用统计"><dl>
      <div><dt>数据库与日志</dt><dd>{formatBytes(usage.databases.bytes)}</dd></div>
      <div><dt>消息图像附件</dt><dd>{usage.attachments.files} 个 · {formatBytes(usage.attachments.bytes)}</dd></div>
      <div><dt>私有数据文件</dt><dd>{formatBytes(usage.privateFiles.bytes)}</dd></div>
      <div><dt>派生索引与日志</dt><dd>{formatBytes(usage.derivedCaches.bytes)}</dd></div>
      <div><dt>未发布附件临时文件</dt><dd>{formatBytes(usage.unpublishedAttachments.bytes)}</dd></div>
      <div><dt>合计</dt><dd>{formatBytes(usage.totalBytes)}</dd></div>
      <div><dt>统计时间</dt><dd>{new Date(usage.measuredAt).toLocaleTimeString('zh-CN')}</dd></div>
    </dl></div>}
    <div className="setting-block"><div><strong>创建一致性备份</strong><p>短暂暂停写入，保存全部必要数据；完成后自动恢复使用。</p></div>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => start('backup', async () => {
        const result = await api.createBackup();
        if (result && mounted.current) setNotice({ error: false, text: `备份已保存：${result.files} 个文件，${formatBytes(result.bytes)}。` });
      }, '备份未完成。原数据已保留，请检查保存位置与可用空间后重试。')}><FolderArchive size={15} />{operation === 'backup' ? '正在创建备份…' : '选择保存位置'}</button></div>
    <div className="setting-block"><div><strong>校验并恢复备份</strong><p>先检查文件完整性、格式和密钥，再展示恢复范围。校验不会改变当前数据。</p></div>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => start('inspect', async () => {
        const result = await api.inspectRestore(); if (!result) return;
        if (!mounted.current) { await api.discardRestore({ ticket: result.ticket }); return; }
        retainedPreview.current = result; setPreview(result);
      }, '此备份未通过校验。原目录未更改；请确认备份完整且属于本机当前账户。')}><ArchiveRestore size={15} />{operation === 'inspect' ? '正在校验备份…' : '选择备份目录'}</button></div>
    {preview && <div className="data-restore-preview" aria-label="恢复范围预览">
      <div className="data-restore-preview-title"><CheckCircle2 size={17} /><strong>备份校验通过</strong></div>
      <dl><div><dt>备份时间</dt><dd>{new Date(preview.createdAt).toLocaleString('zh-CN')}</dd></div>
        <div><dt>恢复范围</dt><dd>{preview.files} 个文件 · {formatBytes(preview.bytes)}</dd></div>
        <div><dt>消息图像附件</dt><dd>{preview.referencedAttachments} 张</dd></div>
        <div><dt>预览有效期</dt><dd>至 {new Date(preview.expiresAt).toLocaleTimeString('zh-CN')}</dd></div></dl>
      <p>恢复会替换应用当前数据并重新启动。当前目录会完整保留；工作区原文件不受影响。</p>
      <div className="data-management-actions"><button type="button" className="secondary-button" disabled={operation !== null} onClick={discard}>取消恢复</button>
        <button type="button" className="primary-button" disabled={operation !== null} onClick={() => setConfirming(true)}>{operation === 'restore' ? '正在完成恢复…' : '恢复并重新启动'}</button></div>
    </div>}
    <div className="setting-block"><div><strong>清理未引用的消息附件</strong>
      <p>先短暂暂停写入并核验全部消息版本，再展示可删除文件。归档与分支历史中的图像引用也会保留。</p>
      <p>此操作只处理孤立附件和未发布临时文件。派生索引由原所有者管理；会话归档、用户历史与恢复证据保持保留。</p></div>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => start('cleanup-inspect', async () => {
        const result = await api.inspectCleanup();
        if (!mounted.current) { await api.discardCleanup({ ticket: result.ticket }); return; }
        retainedCleanup.current = result; setCleanup(result); setCleanupSelected([]);
      }, '未能完整核验附件清理范围，请检查数据后重新预览。')}>{operation === 'cleanup-inspect' ? '正在核验附件…' : '预览附件清理'}</button></div>
    {cleanup && <div className="data-restore-preview" aria-label="附件清理影响预览">
      <div className="data-restore-preview-title"><CheckCircle2 size={17} /><strong>附件清理影响预览</strong></div>
      <dl><div><dt>保留的历史引用图像</dt><dd>{cleanup.referencedObjects} 个</dd></div>
        <div><dt>预览有效期</dt><dd>至 {new Date(cleanup.expiresAt).toLocaleTimeString('zh-CN')}</dd></div></dl>
      <div className="data-cleanup-options">{(['orphan-attachment', 'unpublished-attachment'] as const).map(category => {
        const orphan = category === 'orphan-attachment', files = orphan ? cleanup.orphanObjects : cleanup.unpublishedObjects;
        return <label key={category}><input type="checkbox" checked={cleanupSelected.includes(category)} disabled={operation !== null || files === 0}
          onChange={event => setCleanupSelected(values => event.target.checked ? [...values, category] : values.filter(value => value !== category))} />
          <span>{orphan ? '孤立附件' : '未发布附件临时文件'}：{files} 个 · {formatBytes(orphan ? cleanup.orphanBytes : cleanup.unpublishedBytes)}</span></label>;
      })}</div>
      <p>已选择 {cleanupFiles} 个文件 · {formatBytes(cleanupBytes)}。删除无法撤销，清理不会创建备份。执行前会重新核验预览版本，范围变化时需要重新预览。</p>
      <div className="data-management-actions"><button type="button" className="secondary-button" disabled={operation !== null} onClick={() => {
        const selected = cleanup; start('cleanup-discard', async () => {
          await api.discardCleanup({ ticket: selected.ticket }); retainedCleanup.current = null;
          if (mounted.current) setCleanup(null);
        }, '未能释放清理预览，请稍后重试。');
      }}>取消清理</button><button type="button" className="primary-button" disabled={operation !== null || cleanupFiles === 0}
        onClick={() => setCleanupConfirming(true)}>{operation === 'cleanup-commit' ? '正在清理附件…' : '清理所选附件'}</button></div>
    </div>}
    {notice && <p className={notice.error ? 'is-danger' : 'is-success'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    <ConfirmDialog open={confirming && preview !== null} title="恢复应用数据" confirmLabel="恢复并重新启动"
      description="应用将使用这个已验证备份替换当前数据并重新启动。原目录会完整保留。恢复中断时，下次启动可以选择原目录或恢复目录。"
      onClose={() => setConfirming(false)} onConfirm={() => {
        setConfirming(false); const selected = preview; if (!selected) return;
        start('restore', async () => {
          retainedPreview.current = null;
          try { await api.commitRestore({ ticket: selected.ticket }); }
          finally { if (mounted.current) setPreview(null); }
        }, '恢复未提交。原目录已保留，请重新选择备份进行校验。');
      }} />
    <ConfirmDialog open={cleanupConfirming && cleanup !== null} title="删除所选附件" confirmLabel="删除所选附件"
      description={`将删除 ${cleanupFiles} 个文件，合计 ${formatBytes(cleanupBytes)}。删除无法撤销，清理不会创建备份。全部历史引用及恢复证据保留；范围变化时本次操作会拒绝执行。`}
      onClose={() => setCleanupConfirming(false)} onConfirm={() => {
        setCleanupConfirming(false); const selected = cleanup; if (!selected || cleanupFiles === 0) return;
        const categories = [...cleanupSelected];
        start('cleanup-commit', async () => {
          retainedCleanup.current = null;
          try {
            const result = await api.commitCleanup({ ticket: selected.ticket, version: selected.version, selected: categories });
            if (mounted.current) {
              setUsage(null); setNotice({ error: result.status === 'interrupted', text: result.status === 'completed'
                ? `清理完成：已删除 ${result.filesDeleted} 个文件，${formatBytes(result.bytesDeleted)}。清理记录已保留。`
                : `清理中断：已删除 ${result.filesDeleted} 个文件，${result.filesRetained} 个文件保留。请重新预览；操作记录 ${result.operationId} 与恢复证据已保留。` });
            }
          } finally { if (mounted.current) { setCleanup(null); setCleanupSelected([]); } }
        }, '清理未确认完成，请重新预览。清理记录与恢复证据保留。');
      }} />
  </section>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${units[index]}`;
}
