import type { DatabaseSync } from "node:sqlite";



import type { AgentIntentType, AgentWorkflowType } from "../IntentTypes.js";

import type { TaskContext, TaskPhase, TaskSideEffectSummary } from "./TaskContext.js";



interface SessionTaskRow {

  session_id: string;

  task_id: string | null;

  goal: string | null;

  current_phase: string;

  intent: string;

  workflow_type: string;

  entry_intent: string | null;

  entry_workflow_type: string | null;

  reconciled_intent: string | null;

  reconciled_workflow_type: string | null;

  last_run_id: string | null;

  last_failure: string | null;

  related_files_json: string | null;

  last_stop_reason: string | null;

  last_completed_at: string | null;

  last_completion_status: string | null;

  side_effect_summary_json: string | null;

  is_active: number;

  updated_at: string;

}



export class SessionTaskStore {

  constructor(private readonly db?: DatabaseSync) {}



  get(sessionId: string): TaskContext | undefined {

    if (!this.db) return undefined;

    const row = this.db

      .prepare(

        `SELECT session_id, task_id, goal, current_phase, intent, workflow_type,

                entry_intent, entry_workflow_type, reconciled_intent, reconciled_workflow_type,

                last_run_id, last_failure, related_files_json,

                last_stop_reason, last_completed_at, last_completion_status,

                side_effect_summary_json, is_active, updated_at

         FROM session_task_contexts WHERE session_id = ?`,

      )

      .get(sessionId) as SessionTaskRow | undefined;

    if (!row) return undefined;

    return this.rowToContext(row);

  }



  upsert(context: TaskContext): void {

    if (!this.db) return;

    this.db

      .prepare(

        `INSERT INTO session_task_contexts

         (session_id, task_id, goal, current_phase, intent, workflow_type,

          entry_intent, entry_workflow_type, reconciled_intent, reconciled_workflow_type,

          last_run_id, last_failure, related_files_json,

          last_stop_reason, last_completed_at, last_completion_status,

          side_effect_summary_json, is_active, updated_at)

         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

         ON CONFLICT(session_id) DO UPDATE SET

           task_id = excluded.task_id,

           goal = excluded.goal,

           current_phase = excluded.current_phase,

           intent = excluded.intent,

           workflow_type = excluded.workflow_type,

           entry_intent = excluded.entry_intent,

           entry_workflow_type = excluded.entry_workflow_type,

           reconciled_intent = excluded.reconciled_intent,

           reconciled_workflow_type = excluded.reconciled_workflow_type,

           last_run_id = excluded.last_run_id,

           last_failure = excluded.last_failure,

           related_files_json = excluded.related_files_json,

           last_stop_reason = excluded.last_stop_reason,

           last_completed_at = excluded.last_completed_at,

           last_completion_status = excluded.last_completion_status,

           side_effect_summary_json = excluded.side_effect_summary_json,

           is_active = excluded.is_active,

           updated_at = excluded.updated_at`,

      )

      .run(

        context.sessionId,

        context.taskId ?? null,

        context.goal ?? null,

        context.currentPhase,

        context.intent,

        context.workflowType,

        context.entryIntent ?? null,

        context.entryWorkflowType ?? null,

        context.reconciledIntent ?? null,

        context.reconciledWorkflowType ?? null,

        context.lastRunId ?? null,

        context.lastFailure ?? null,

        context.relatedFiles?.length ? JSON.stringify(context.relatedFiles) : null,

        context.lastStopReason ?? null,

        context.lastCompletedAt ?? null,

        context.lastCompletionStatus ?? null,

        context.lastSideEffectSummary

          ? JSON.stringify(context.lastSideEffectSummary)

          : null,

        context.isActive ? 1 : 0,

        context.updatedAt,

      );

  }



  markInactive(sessionId: string): void {

    if (!this.db) return;

    this.db

      .prepare(

        `UPDATE session_task_contexts

         SET is_active = 0, current_phase = 'idle', updated_at = ?

         WHERE session_id = ?`,

      )

      .run(new Date().toISOString(), sessionId);

  }



  private rowToContext(row: SessionTaskRow): TaskContext {

    let relatedFiles: string[] | undefined;

    if (row.related_files_json) {

      try {

        const parsed = JSON.parse(row.related_files_json) as unknown;

        if (Array.isArray(parsed)) relatedFiles = parsed.filter((v) => typeof v === "string");

      } catch {

        relatedFiles = undefined;

      }

    }

    let lastSideEffectSummary: TaskSideEffectSummary | undefined;

    if (row.side_effect_summary_json) {

      try {

        const parsed = JSON.parse(row.side_effect_summary_json) as TaskSideEffectSummary;

        if (parsed && Array.isArray(parsed.wroteFiles)) {

          lastSideEffectSummary = {

            wroteFiles: parsed.wroteFiles.filter((v) => typeof v === "string"),

            ranShell: Boolean(parsed.ranShell),

          };

        }

      } catch {

        lastSideEffectSummary = undefined;

      }

    }

    return {

      sessionId: row.session_id,

      taskId: row.task_id ?? undefined,

      goal: row.goal ?? undefined,

      currentPhase: row.current_phase as TaskPhase,

      intent: row.intent as AgentIntentType,

      workflowType: row.workflow_type as AgentWorkflowType,

      entryIntent: row.entry_intent ? (row.entry_intent as AgentIntentType) : undefined,

      entryWorkflowType: row.entry_workflow_type

        ? (row.entry_workflow_type as AgentWorkflowType)

        : undefined,

      reconciledIntent: row.reconciled_intent

        ? (row.reconciled_intent as AgentIntentType)

        : undefined,

      reconciledWorkflowType: row.reconciled_workflow_type

        ? (row.reconciled_workflow_type as AgentWorkflowType)

        : undefined,

      lastRunId: row.last_run_id ?? undefined,

      lastFailure: row.last_failure ?? undefined,

      lastStopReason: row.last_stop_reason ?? undefined,

      lastCompletedAt: row.last_completed_at ?? undefined,

      lastCompletionStatus: row.last_completion_status ?? undefined,

      lastSideEffectSummary,

      relatedFiles,

      isActive: row.is_active === 1,

      updatedAt: row.updated_at,

    };

  }

}
