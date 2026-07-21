import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileCode2, FileJson2, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import type { WorkspaceEntry } from '@shared/contract';
import type { FeaturePanelProps } from '@renderer/core/modules/module-contract';

interface TreeNode extends WorkspaceEntry {
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
}

export function FileExplorerPanel({ moduleId, services }: FeaturePanelProps): React.JSX.Element {
  const [rootLabel, setRootLabel] = useState('Workspace');
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadRoot = async (): Promise<void> => {
    try {
      const listing = await services.workspace.listDirectory({ relativePath: '' });
      setRootLabel(listing.rootLabel);
      setNodes(listing.entries);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取工作区');
    }
  };

  useEffect(() => { void loadRoot(); }, [services]);

  const toggle = async (path: string): Promise<void> => {
    const target = findNode(nodes, path);
    if (!target || target.type !== 'directory') return;
    if (target.children) {
      setNodes(updateNode(nodes, path, (node) => ({ ...node, expanded: !node.expanded })));
      return;
    }
    setNodes(updateNode(nodes, path, (node) => ({ ...node, loading: true, expanded: true })));
    try {
      const listing = await services.workspace.listDirectory({ relativePath: path });
      setNodes((current) => updateNode(current, path, (node) => ({ ...node, loading: false, expanded: true, children: listing.entries })));
      setError(null);
    } catch (cause) {
      setNodes((current) => updateNode(current, path, (node) => ({ ...node, loading: false, expanded: false })));
      setError(cause instanceof Error ? cause.message : '无法读取目录');
    }
  };

  return (
    <section className="simple-module-panel file-explorer" aria-labelledby={`${moduleId}-title`}>
      <header className="module-content-header"><div><span>WORKSPACE</span><h1 id={`${moduleId}-title`}>{rootLabel}</h1></div><button type="button" className="bare-icon-button" title="刷新" onClick={() => void loadRoot()}><RefreshCw size={14} /></button></header>
      {error && <p className="is-danger">{error}</p>}
      <div className="file-tree">{nodes.map((node) => <TreeEntry key={node.relativePath} node={node} depth={0} onToggle={toggle} />)}</div>
    </section>
  );
}

function TreeEntry({ node, depth, onToggle }: { node: TreeNode; depth: number; onToggle(path: string): Promise<void> }): React.JSX.Element {
  const directory = node.type === 'directory';
  const Icon = directory ? node.expanded ? FolderOpen : Folder : fileIcon(node.name);
  return (
    <>
      <p style={{ paddingLeft: `${4 + depth * 14}px` }} onClick={() => directory && void onToggle(node.relativePath)}>
        {directory ? node.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span />}
        <Icon size={14} /> {node.name}{node.loading && '…'}
      </p>
      {node.expanded && node.children?.map((child) => <TreeEntry key={child.relativePath} node={child} depth={depth + 1} onToggle={onToggle} />)}
    </>
  );
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
