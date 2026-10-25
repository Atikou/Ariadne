import { PUBLIC_PROJECTION_CONTRACT_VERSION, type RuntimeResult } from '@ariadne/protocol/public';
import type { RuntimeFeatureCommandGateway } from './runtime-feature-command-gateway';
import { ScheduleOccurrenceFeatureStore } from './schedule-occurrence-feature-store';
import { ProductivityTaskFaultFeatureStore } from './productivity-task-fault-feature-store';

export type ProductivitySnapshot = Extract<
  RuntimeResult,
  { kind: 'productivity.query_result' }
>;
export type ProductivityGoal = NonNullable<ProductivitySnapshot['goal']>;
export type ProductivityWorkflow = ProductivitySnapshot['workflows'][number];
export type ProductivitySchedule = Extract<
  RuntimeResult,
  { kind: 'schedules.query_result' }
>['schedules'][number];

export class ProductivityFeatureStore {
  readonly scheduleOccurrences: ScheduleOccurrenceFeatureStore;
  readonly taskFaults: ProductivityTaskFaultFeatureStore;
  constructor(private readonly gateway: RuntimeFeatureCommandGateway) {
    this.scheduleOccurrences = new ScheduleOccurrenceFeatureStore(gateway);
    this.taskFaults = new ProductivityTaskFaultFeatureStore(gateway);
  }

  async query(workspaceId: string, sessionId: string): Promise<ProductivitySnapshot> {
    const result = await this.gateway.execute({
      kind: 'productivity.query',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      sessionId
    });
    if (result.kind !== 'productivity.query_result') {
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
      kind: 'goal.put',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input
    });
    if (result.kind !== 'goal.updated') {
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
    items: readonly Omit<ProductivitySnapshot['todos'][number], 'ordinal'>[];
  }): Promise<number> {
    const result = await this.gateway.execute({
      kind: 'todo.snapshot.replace',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input,
      items: [...input.items]
    });
    if (result.kind !== 'todo.snapshot.replaced') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.revision;
  }

  async startGoalAutonomy(input: { workspaceId: string; sessionId: string; goalId: string; expectedVersion: number;
    criteria: readonly string[]; maxConcurrency: number; deadlineAt: string }): Promise<ProductivityGoal> {
    const result = await this.gateway.execute({ ...input, criteria: [...input.criteria],
      kind: 'goal.autonomy.start', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION });
    if (result.kind !== 'goal.updated') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.goal;
  }
  async transitionGoalAutonomy(input: { workspaceId: string; sessionId: string; goalId: string; expectedVersion: number;
    action: 'pause' | 'resume' }): Promise<ProductivityGoal> {
    const result = await this.gateway.execute({ ...input, kind: 'goal.autonomy.transition', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION });
    if (result.kind !== 'goal.updated') throw new Error(`runtime_result_invalid:${result.kind}`);
    return result.goal;
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
    executionMode?: 'manual' | 'agent';
    deadlineAt: string;
  }): Promise<ProductivityWorkflow> {
    const result = await this.gateway.execute({
      kind: 'workflow.start',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input,
      todoIds: [...input.todoIds]
    });
    if (result.kind !== 'workflow.updated') {
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
      kind: 'workflow.advance',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input,
      completed: [...input.completed]
    });
    if (result.kind !== 'workflow.updated') {
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
      kind: 'workflow.cancel',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input
    });
    if (result.kind !== 'workflow.updated') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.workflow;
  }

  async querySchedules(
    workspaceId: string,
    sessionId: string
  ): Promise<readonly ProductivitySchedule[]> {
    const result = await this.gateway.execute({
      kind: 'schedules.query',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      workspaceId,
      sessionId
    });
    if (result.kind !== 'schedules.query_result') {
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
      kind: 'schedule.create',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input
    });
    if (result.kind !== 'schedule.updated') {
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
      kind: 'schedule.transition',
      contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      ...input
    });
    if (result.kind !== 'schedule.updated') {
      throw new Error(`runtime_result_invalid:${result.kind}`);
    }
    return result.schedule;
  }
}
