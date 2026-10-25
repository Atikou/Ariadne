import type { ProductivityFeatureStore, ProductivitySnapshot } from '@renderer/core/runtime/features/productivity-feature-store';
import { todoStatusText, workflowStatusText } from './ProductivityPresentation';

export function ProductivityWorkflows({ snapshot, productivity, workspaceId, sessionId, run, openSession }: {
  snapshot: ProductivitySnapshot; productivity: ProductivityFeatureStore; workspaceId: string; sessionId: string;
  run(operation: () => Promise<unknown>): void; openSession(sessionId: string): Promise<void>;
}): React.JSX.Element {
  const services = { productivity, sessions: { select: openSession } };
  return <div className="productivity-workflows" aria-label="工作流与结果">
      {snapshot.workflows.map((workflow) => <article className="productivity-card" key={workflow.workflowId}
        data-workflow-id={workflow.workflowId} data-workflow-version={workflow.version} data-workflow-status={workflow.status}>
        <h2>工作流 · {workflowStatusText[workflow.status]}</h2>
        <p>活动任务 {workflow.activeTodoIds.length}/{workflow.maxConcurrency} · 已确认 {workflow.transitionsUsed}/{workflow.maxTransitions}</p>
        <details><summary>执行配置与版本</summary><small>工作流版本 {workflow.version} · 最大并发 {workflow.maxConcurrency} · 截止时间 {new Date(workflow.deadlineAt).toLocaleString()}</small></details>
        {workflow.activeTodoIds.map((todoId) => <div className="productivity-inline" key={todoId}>
          <span>{snapshot.todos.find((todo) => todo.todoId === todoId)?.title ?? todoId}</span>
          {workflow.taskRuns?.find(task => task.todoId === todoId) && <button type="button" onClick={() => run(() => services.sessions.select(workflow.taskRuns!.find(task => task.todoId === todoId)!.sessionId))}>打开任务会话</button>}
          {workflow.executionMode !== 'agent' && (['completed', 'failed'] as const).map(outcome => <button type="button" key={outcome} onClick={() => run(() => services.productivity.advanceWorkflow({
            workspaceId, sessionId, workflowId: workflow.workflowId, expectedVersion: workflow.version,
            completed: [{ todoId, outcome, summary: outcome === 'completed' ? 'user_confirmed_complete' : 'user_reported_failure' }]
          }))}>{outcome === 'completed' ? '完成' : '失败'}</button>)}
        </div>)}
        {workflow.status === 'running' && <button type="button" onClick={() => run(() => services.productivity.cancelWorkflow({ workspaceId, sessionId, workflowId: workflow.workflowId, expectedVersion: workflow.version }))}>取消工作流</button>}
        {workflow.status === 'cancelling' && <p role="status">正在取消，等待任务 Run 确认结束；结果未知的工具仍需在任务会话中处理恢复决策。</p>}
        {workflow.executionMode === 'agent' && workflow.taskRuns?.filter(task => !workflow.activeTodoIds.includes(task.todoId)).map(task => <button key={task.todoId} type="button" onClick={() => run(() => services.sessions.select(task.sessionId))}>查看任务结果：{snapshot.todos.find(todo => todo.todoId === task.todoId)?.title ?? task.todoId}</button>)}
        {workflow.results.length > 0 && <ul>{workflow.results.map(result => <li key={result.todoId}>{snapshot.todos.find(todo => todo.todoId === result.todoId)?.title ?? result.todoId} · {todoStatusText[result.outcome]} · {result.summary}</li>)}</ul>}
      </article>)}
  </div>;
}
