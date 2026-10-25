import type { RuntimeCommand } from '@ariadne/protocol/public';

/** These actions create or admit model work. Reads, reconciliation of old
 * effects, cancellation and recording future schedules remain independent. */
export function commandRequiresInference(command: RuntimeCommand): boolean {
  return command.kind === 'model.qualification.run'
    || command.kind === 'model.availability.check' || command.kind === 'conversation.session.title.generate'
    || command.kind === 'conversation.message.accept'
    || (command.kind === 'workflow.start' && command.executionMode === 'agent')
    || command.kind === 'goal.autonomy.start'
    || (command.kind === 'goal.autonomy.transition' && command.action === 'resume');
}
