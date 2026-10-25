import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, File, FileCode2, FileJson2, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import type { WorkspaceEntry } from '@shared/contract';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';
import { getNearestScrollDelta } from '@shared/scroll-geometry';
import { PanelEmptyState } from '@renderer/shared/ui/PanelEmptyState';
import { TextPromptDialog } from '@renderer/shared/ui/ActionDialog';
import { workspaceDocumentPathSchema } from '@ariadne/protocol/public';
import { WorkspaceDocumentEditor } from './WorkspaceDocumentEditor';
import './file-explorer.css';

interface TreeNode extends WorkspaceEntry {
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
}

export function FileExplorerPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const [documentSelection,setDocumentSelection]=useState<{workspaceId:string;path:string;create:boolean;recovery?:boolean}|null>(null);
  useSyncExternalStore(services.documents.subscribe,services.documents.getSnapshot,services.documents.getSnapshot);
  const fileDrafts=services.documents.unsavedDrafts();
  const [creating,setCreating]=useState<string|null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    () => services.conversationNavigation.getSelectedWorkspaceId()
  );
  const [rootLabel, setRootLabel] = useState('工作区文件');
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const workspaceIdRef = useRef(workspaceId);
  const treeRevisionRef = useRef(0);
  workspaceIdRef.current = workspaceId;
  const selectionGeneration=useRef(0);
  const selectDocument=async(path:string,create:boolean):Promise<void>=>{
    if(!workspaceId)return;
    const selectedWorkspace=workspaceId,generation=++selectionGeneration.current;
    try{
      const canonical=await services.documents.resolvePath(selectedWorkspace,path);
      if(workspaceIdRef.current!==selectedWorkspace||selectionGeneration.current!==generation)return;
      setDocumentSelection({workspaceId:selectedWorkspace,path:canonical,create});setError(null);
    }catch(error){if(workspaceIdRef.current===selectedWorkspace&&selectionGeneration.current===generation)setError(error instanceof Error?error.message:'无法核对文件身份。');}
  };

  const loadRoot = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    const requestedWorkspaceId = workspaceId;
    const revision = ++treeRevisionRef.current;
    setLoading(true);
    setError(null);
    try {
      const listing = await services.workspace.listDirectory({
        workspaceId: requestedWorkspaceId,
        relativePath: ''
      });
      if (workspaceIdRef.current !== requestedWorkspaceId || treeRevisionRef.current !== revision) return;
      setRootLabel(listing.rootLabel);
      setNodes(listing.entries);
      setError(null);
    } catch (cause) {
      if (workspaceIdRef.current !== requestedWorkspaceId || treeRevisionRef.current !== revision) return;
      setError(cause instanceof Error ? cause.message : '无法读取工作区');
    } finally {
      if (workspaceIdRef.current === requestedWorkspaceId && treeRevisionRef.current === revision) setLoading(false);
    }
  }, [services, workspaceId]);

  useEffect(() => {
    const unsubscribe = services.conversationNavigation.onSelectedWorkspaceChanged(setWorkspaceId);
    void services.conversationNavigation.listWorkspaces().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : '无法读取工作区目录');
    });
    return unsubscribe;
  }, [services]);

  useEffect(() => {
    setRootLabel('工作区文件');
    setNodes([]);
    setFocusedPath(null);
    setLoading(false);
    setError(null);
    if (workspaceId) void loadRoot();
    return () => { treeRevisionRef.current += 1; };
  }, [loadRoot]);

  const toggle = async (path: string): Promise<void> => {
    if (!workspaceId) return;
    const requestedWorkspaceId = workspaceId;
    const revision = treeRevisionRef.current;
    const target = findNode(nodes, path);
    if (!target || target.type !== 'directory' || target.loading) return;
    if (target.children) {
      setNodes(current => updateNode(current, path, (node) => ({ ...node, expanded: !node.expanded })));
      return;
    }
    setNodes(current => updateNode(current, path, (node) => ({ ...node, loading: true, expanded: true })));
    try {
      const listing = await services.workspace.listDirectory({
        workspaceId: requestedWorkspaceId,
        relativePath: path
      });
      if (workspaceIdRef.current !== requestedWorkspaceId || treeRevisionRef.current !== revision) return;
      setNodes((current) => updateNode(current, path, (node) => ({ ...node, loading: false, expanded: true, children: listing.entries })));
      setError(null);
    } catch (cause) {
      if (workspaceIdRef.current !== requestedWorkspaceId || treeRevisionRef.current !== revision) return;
      setNodes((current) => updateNode(current, path, (node) => ({ ...node, loading: false, expanded: false })));
      setError(cause instanceof Error ? cause.message : '无法读取目录');
    }
  };

  const visible = flattenTree(nodes);
  const activePath = visible.some(({ node }) => node.relativePath === focusedPath) ? focusedPath : visible[0]?.node.relativePath;
  const focus = (path: string | undefined): void => { if (path) rowRefs.current.get(path)?.focus({ preventScroll: true }); };
  const navigate = (event: KeyboardEvent<HTMLLIElement>, index: number): void => {
    const entry = visible[index];
    if (!entry) return;
    const { node, parentPath } = entry;
    if (event.key === 'ArrowDown') focus(visible[index + 1]?.node.relativePath);
    else if (event.key === 'ArrowUp') focus(visible[index - 1]?.node.relativePath);
    else if (event.key === 'Home') focus(visible[0]?.node.relativePath);
    else if (event.key === 'End') focus(visible.at(-1)?.node.relativePath);
    else if (event.key === 'ArrowRight') {
      if (node.type === 'directory' && !node.expanded) void toggle(node.relativePath);
      else if (node.children?.length) focus(node.children[0]?.relativePath);
    } else if (event.key === 'ArrowLeft') {
      if (node.type === 'directory' && node.expanded) void toggle(node.relativePath);
      else focus(parentPath);
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (node.type === 'directory') void toggle(node.relativePath);
      else void selectDocument(node.relativePath,false);
    } else return;
    event.preventDefault();
  };

  const visibleDocument=documentSelection&&(documentSelection.workspaceId===workspaceId||documentSelection.recovery);
  return <section className={`file-explorer${visibleDocument?' has-document':''}`} aria-labelledby={`${moduleId}-title`}>
    <header className="module-content-header"><div><span>目录与文本编辑</span><h1 id={`${moduleId}-title`} title={rootLabel}>{rootLabel}</h1></div><button type="button" disabled={!workspaceId} onClick={()=>setCreating(workspaceId)}>新建文件</button><button type="button" className="bare-icon-button" aria-label="刷新文件列表" disabled={!workspaceId || loading} onClick={() => void loadRoot()}><RefreshCw size={15} /></button></header>
    <div ref={scrollRef} className="file-explorer-body" aria-busy={loading}>
      {error && <p className="file-explorer-error" role="alert">{error}</p>}
      {fileDrafts.length>0&&<section className="file-draft-list" aria-label="未保存文件草稿"><strong>未保存文件 · {fileDrafts.length}</strong>{fileDrafts.map(row=><button key={row.draftId} type="button" onClick={()=>setDocumentSelection({workspaceId:row.workspaceId,path:row.path,create:!row.exists,recovery:true})}><span>{row.path}</span><small>{services.conversationNavigation.isWorkspaceActive(row.workspaceId)?'工作区草稿':'工作区当前不可用'} · {row.pendingMutation?'原操作待核对':services.documents.isRecovered(row.workspaceId,row.path)?'已恢复':'正在编辑'}</small></button>)}</section>}
      {!workspaceId ? <PanelEmptyState icon={FolderOpen} title="尚未选择工作区" description="从会话侧栏打开或选择工作区，即可浏览目录。" />
        : loading && nodes.length === 0 ? <p className="file-explorer-loading" role="status">正在读取目录…</p>
        : nodes.length === 0 && !error ? <PanelEmptyState icon={Folder} title="文件夹为空" description="工作区中的文件和文件夹会显示在这里。" />
        : <ul className="file-tree" role="tree" aria-label={rootLabel}>{visible.map(({ node, depth }, index) => {
          const directory = node.type === 'directory';
          const Icon = directory ? node.expanded ? FolderOpen : Folder : fileIcon(node.name);
          return <li
            key={node.relativePath}
            ref={element => { if (element) rowRefs.current.set(node.relativePath, element); else rowRefs.current.delete(node.relativePath); }}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={directory ? Boolean(node.expanded) : undefined}
            aria-busy={node.loading || undefined}
            aria-selected={activePath === node.relativePath}
            tabIndex={activePath === node.relativePath ? 0 : -1}
            title={node.relativePath}
            style={{ paddingLeft: 8 + depth * 16 }}
            onFocus={event => {
              setFocusedPath(node.relativePath);
              const viewport = scrollRef.current;
              if (!viewport) return;
              const bounds = viewport.getBoundingClientRect();
              const item = event.currentTarget.getBoundingClientRect();
              viewport.scrollTop += getNearestScrollDelta(bounds.top, bounds.bottom, item.top, item.bottom, 8);
            }}
            onKeyDown={event => navigate(event, index)}
            onClick={event => { event.currentTarget.focus(); if (directory) void toggle(node.relativePath); else void selectDocument(node.relativePath,false); }}
          >
            {directory ? node.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="file-tree-spacer" />}
            <Icon size={15} /><span className="file-tree-name">{node.name}</span>
            {node.loading && <small>读取中…</small>}
            {node.expanded && node.children?.length === 0 && <small>空</small>}
          </li>;
        })}</ul>}
    </div>
    {documentSelection&&visibleDocument&&<WorkspaceDocumentEditor workspaceId={documentSelection.workspaceId} path={documentSelection.path} create={documentSelection.create} services={services}
      onClose={()=>setDocumentSelection(null)} onMoved={path=>setDocumentSelection({...documentSelection,path,create:false})} onChanged={()=>void loadRoot()}/>}
    <TextPromptDialog open={creating!==null&&creating===workspaceId} title="新建工作区文件" description="输入工作区内的相对路径。已有文件不会被覆盖；保存需要工作区写权限。" initialValue="" fieldLabel="文件路径" maxLength={1024} confirmLabel="开始编辑"
      onClose={()=>setCreating(null)} onConfirm={path=>{
        setCreating(null);
        if(!workspaceId||creating!==workspaceId||!workspaceDocumentPathSchema.safeParse(path).success){setError('请输入有效的工作区相对文件路径。');return;}
        void selectDocument(path,true);
      }}/>
  </section>;
}

function flattenTree(nodes: TreeNode[], depth = 0, parentPath?: string): Array<{ node: TreeNode; depth: number; parentPath: string | undefined }> {
  return nodes.flatMap(node => [
    { node, depth, parentPath },
    ...(node.expanded && node.children ? flattenTree(node.children, depth + 1, node.relativePath) : [])
  ]);
}

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.relativePath === path) return node;
    const nested = node.children ? findNode(node.children, path) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

function updateNode(nodes: TreeNode[], path: string, update: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((node) => node.relativePath === path
    ? update(node)
    : node.children ? { ...node, children: updateNode(node.children, path, update) } : node);
}

function fileIcon(name: string): typeof File {
  if (name.endsWith('.json')) return FileJson2;
  if (/\.(?:ts|tsx|js|jsx|css|html|md)$/i.test(name)) return FileCode2;
  return File;
}
