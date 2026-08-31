import {
  PUBLIC_PROJECTION_CONTRACT_VERSION,
  type RuntimeCommand,
  type RuntimeResult
} from '@ariadne/protocol/public';

export type ProductivitySnapshot = Extract<
  RuntimeResult,
  { kind: 'productivity.query_result.v3' }
>;
export type ProductivityGoal = NonNullable<ProductivitySnapshot['goal']>;
export type ProductivityWorkflow = ProductivitySnapshot['workflows'][number];
export type ProductivitySchedule = Extract<
  RuntimeResult,
  { kind: 'schedules.query_result.v3' }
>['schedules'][number];

export interface RuntimeFeatureCommandGateway {
  execute(command: RuntimeCommand): Promise<RuntimeResult>;
}

export class ProductivityFeatureStore {
  constructor(private readonly gateway: RuntimeFeatureCommandGateway) {}

  async query(workspaceId: string, sessionId: string): Promise<ProductivitySnapshot> {
    const result = await this.gateway.execute({
      kind: 'productivity.query.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      sessionId
    });
    if (result.kind !== 'productivity.query_result.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result;
  }

  async putGoal(input: {
    workspaceId: string;
    sessionId: string;
    goalId: string;
    expectedVersion: number | null;
    title: string;
    phase: string;
    status: ProductivityGoal['status'];
    roundCap: number;
  }): Promise<ProductivityGoal> {
    const result = await this.gateway.execute({
      kind: 'goal.put.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input
    });
    if (result.kind !== 'goal.updated.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.goal;
  }

  async replaceTodos(input: {
    workspaceId: string;
    sessionId: string;
    goalId: string;
    expectedGoalVersion: number;
    expectedRevision: number | null;
    items: readonly {
      todoId: string;
      title: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    }[];
  }): Promise<number> {
    const result = await this.gateway.execute({
      kind: 'todo.snapshot.replace.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input,
      items: [...input.items]
    });
    if (result.kind !== 'todo.snapshot.replaced.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.revision;
  }

  async startWorkflow(input: {
    workspaceId: string;
    sessionId: string;
    workflowId: string;
    goalId: string;
    expectedGoalVersion: number;
    expectedTodoRevision: number;
    todoIds: readonly string[];
    maxConcurrency: number;
    maxTransitions: number;
    deadlineAt: string;
  }): Promise<ProductivityWorkflow> {
    const result = await this.gateway.execute({
      kind: 'workflow.start.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input,
      todoIds: [...input.todoIds]
    });
    if (result.kind !== 'workflow.updated.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.workflow;
  }

  async advanceWorkflow(input: {
    workspaceId: string;
    sessionId: string;
    workflowId: string;
    expectedVersion: number;
    completed: readonly {
      todoId: string;
      outcome: 'completed' | 'failed';
      summary: string;
    }[];
  }): Promise<ProductivityWorkflow> {
    const result = await this.gateway.execute({
      kind: 'workflow.advance.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input,
      completed: [...input.completed]
    });
    if (result.kind !== 'workflow.updated.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.workflow;
  }

  async cancelWorkflow(input: {
    workspaceId: string;
    sessionId: string;
    workflowId: string;
    expectedVersion: number;
  }): Promise<ProductivityWorkflow> {
    const result = await this.gateway.execute({
      kind: 'workflow.cancel.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input
    });
    if (result.kind !== 'workflow.updated.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.workflow;
  }

  async querySchedules(
    workspaceId: string,
    sessionId: string
  ): Promise<readonly ProductivitySchedule[]> {
    const result = await this.gateway.execute({
      kind: 'schedules.query.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      sessionId
    });
    if (result.kind !== 'schedules.query_result.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.schedules;
  }

  async createSchedule(input: {
    workspaceId: string;
    sessionId: string;
    scheduleId: string;
    prompt: string;
    timing: ProductivitySchedule['timing'];
  }): Promise<ProductivitySchedule> {
    const result = await this.gateway.execute({
      kind: 'schedule.create.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input
    });
    if (result.kind !== 'schedule.updated.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.schedule;
  }

  async transitionSchedule(input: {
    workspaceId: string;
    sessionId: string;
    scheduleId: string;
    expectedVersion: number;
    action: 'pause' | 'resume' | 'cancel';
  }): Promise<ProductivitySchedule> {
    const result = await this.gateway.execute({
      kind: 'schedule.transition.v3',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input
    });
    if (result.kind !== 'schedule.updated.v3') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.schedule;
  }
}
