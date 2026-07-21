import { useState } from 'react';
import { FolderLock, ShieldCheck } from 'lucide-react';
import { StatusPill } from '@renderer/shared/ui/StatusPill';

export function PermissionRequestCard(): React.JSX.Element {
  const [decision, setDecision] = useState<'approved' | 'denied' | 'pending'>('pending');
  const [scope, setScope] = useState('E:\\Project\\Ariadne（仅本次任务）');

  return (
    <section className="permission-card">
      <header>
        <span className="permission-icon"><FolderLock size={17} /></span>
        <div><strong>需要工作区访问权限</strong><p>Agent 准备读取项目文件并执行类型检查。</p></div>
        <StatusPill tone={decision === 'approved' ? 'success' : decision === 'denied' ? 'danger' : 'warning'}>
          {decision === 'approved' ? '已批准' : decision === 'denied' ? '已拒绝' : '等待确认'}
        </StatusPill>
      </header>
      <div className="permission-scope">
        <ShieldCheck size={14} />
        <div><span>访问范围</span><strong>{scope}</strong></div>
      </div>
      <ul>
        <li>读取源码和项目配置</li>
        <li>运行 <code>npm run typecheck</code></li>
        <li>不会访问工作区外文件，不会执行删除命令</li>
      </ul>
      {decision === 'pending' && (
        <footer>
          <button type="button" className="ghost-button" onClick={() => setDecision('denied')}>拒绝</button>
          <button type="button" className="secondary-button" onClick={() => setScope('E:\\Project\\Ariadne\\src（仅本次任务）')}>修改范围</button>
          <button type="button" className="primary-button" onClick={() => setDecision('approved')}>批准一次</button>
        </footer>
      )}
    </section>
  );
}
