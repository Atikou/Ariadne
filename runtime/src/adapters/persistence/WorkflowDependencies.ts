import { ProductivityCommandRejected } from './ProductivityCommandRejected.js';
import type { ProductivityResult } from '@ariadne/protocol/public';

type Todo = Extract<ProductivityResult, { kind: 'todo.snapshot.replaced' }>['items'][number];
type Workflow = Extract<ProductivityResult, { kind: 'workflow.updated' }>['workflow'];

/** Validate the complete snapshot, rather than only the nodes selected for this round. */
export function assertTodoDependencies(items: readonly { todoId: string; dependsOn?: readonly string[] }[]): void {
  const nodes = new Map(items.map(item => [item.todoId, item.dependsOn ?? []]));
  if (nodes.size !== items.length) throw new ProductivityCommandRejected('todo_id_duplicate');
  for (const [id, dependencies] of nodes) {
    if (new Set(dependencies).size !== dependencies.length) throw new ProductivityCommandRejected('todo_dependency_duplicate');
    if (dependencies.some(dependency => dependency === id || !nodes.has(dependency))) throw new ProductivityCommandRejected('todo_dependency_invalid');
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ProductivityCommandRejected('todo_dependency_cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of nodes.get(id)!) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);
}

export function workflowDependenciesForSelection(items: readonly Todo[], selected: readonly string[]): NonNullable<Workflow['dependencies']> {
  assertTodoDependencies(items);
  const selection = new Set(selected);
  const nodes = new Map(items.map(item => [item.todoId, item]));
  return selected.map(todoId => {
    const dependencies = nodes.get(todoId)?.dependsOn ?? [];
    if (dependencies.some(id => !selection.has(id) && nodes.get(id)?.status !== 'completed')) {
      throw new ProductivityCommandRejected('workflow_dependency_unavailable');
    }
    return { todoId, dependsOn: dependencies.filter(id => selection.has(id)) };
  });
}

export function readyWorkflowTodoIds(workflow: Pick<Workflow, 'dependencies' | 'results' | 'pendingTodoIds'>, slots: number): string[] {
  const completed = new Set(workflow.results.filter(result => result.outcome === 'completed').map(result => result.todoId));
  const nodes = new Map(workflow.dependencies?.map(item => [item.todoId, item.dependsOn]));
  return workflow.pendingTodoIds.filter(id => (nodes.get(id) ?? []).every(dependency => completed.has(dependency))).slice(0, slots);
}
