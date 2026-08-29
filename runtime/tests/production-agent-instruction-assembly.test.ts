import { describe, expect, it, vi } from 'vitest';

import {
  ProductionAgentInstructionAssembly,
  renderAgentInstructionSnapshot
} from '../src/composition/instructions/ProductionAgentInstructionAssembly.js';
import type {
  AgentInstructionAssemblyRequest,
  AgentInstructionContributor
} from '../src/control/ports/AgentInstructionAssembly.js';

const REQUEST: AgentInstructionAssemblyRequest = Object.freeze({
  runId: 'run-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  executionMode: 'agent'
});

describe('ProductionAgentInstructionAssembly', () => {
  it('pins stable contributor order, scope, revision, and provenance into the Turn input', async () => {
    const assembly = new ProductionAgentInstructionAssembly([
      contributor('second.instructions', 200, 'second', 'Second instruction.'),
      contributor('first.instructions', 100, 'first', 'First instruction.')
    ]);

    const snapshot = await assembly.assemble(REQUEST, new AbortController().signal);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.blocks.map((block) => block.contributorId)).toEqual([
      'first.instructions',
      'second.instructions'
    ]);
    expect(snapshot.blocks[0]).toMatchObject({
      blockId: 'first',
      contributorVersion: '1.0.0',
      order: 100_000,
      scope: { kind: 'workspace', workspaceId: 'workspace-1' },
      revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    expect(renderAgentInstructionSnapshot(snapshot, REQUEST)[0]).toContain(
      '[AGENT_INSTRUCTION contributor=first.instructions version=1.0.0 block=first'
    );
  });

  it('fails the whole snapshot when one contributor fails', async () => {
    const completed = vi.fn();
    const assembly = new ProductionAgentInstructionAssembly([
      contributor('first.instructions', 100, 'first', 'First instruction.', completed),
      {
        descriptor: {
          contributorId: 'failed.instructions',
          version: '1.0.0',
          order: 200,
          executionModes: ['agent']
        },
        contribute: async () => { throw new Error('contributor_failed'); }
      }
    ]);

    await expect(assembly.assemble(REQUEST, new AbortController().signal))
      .rejects.toThrow('contributor_failed');
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('accepts instruction content longer than identifier limits', async () => {
    const content = '人设指令。'.repeat(200);
    const snapshot = await new ProductionAgentInstructionAssembly([
      contributor('persona.instructions', 100, 'persona', content)
    ]).assemble(REQUEST, new AbortController().signal);

    expect(snapshot.blocks[0]?.content).toBe(content);
  });

  it('honors cancellation at contributor boundaries', async () => {
    const controller = new AbortController();
    const later = vi.fn();
    const assembly = new ProductionAgentInstructionAssembly([
      {
        descriptor: {
          contributorId: 'aborting.instructions',
          version: '1.0.0',
          order: 100,
          executionModes: ['agent']
        },
        contribute: async () => {
          controller.abort(new Error('cancelled'));
          return [];
        }
      },
      contributor('later.instructions', 200, 'later', 'Later instruction.', later)
    ]);

    await expect(assembly.assemble(REQUEST, controller.signal)).rejects.toThrow('cancelled');
    expect(later).not.toHaveBeenCalled();
  });

  it('rejects a snapshot whose subject, scope, or digest contradicts admission', async () => {
    const snapshot = await new ProductionAgentInstructionAssembly([
      contributor('first.instructions', 100, 'first', 'First instruction.')
    ]).assemble(REQUEST, new AbortController().signal);
    const contradicted = {
      ...snapshot,
      blocks: [{ ...snapshot.blocks[0]!, revision: `sha256:${'0'.repeat(64)}` }]
    };

    expect(() => renderAgentInstructionSnapshot(contradicted, REQUEST))
      .toThrow('instruction_assembly_block_invalid');
  });
});

function contributor(
  contributorId: string,
  order: number,
  blockId: string,
  content: string,
  observed: () => void = () => undefined
): AgentInstructionContributor {
  return {
    descriptor: {
      contributorId,
      version: '1.0.0',
      order,
      executionModes: ['agent']
    },
    contribute: async (request) => {
      observed();
      return [{
        blockId,
        scope: { kind: 'workspace', workspaceId: request.workspaceId },
        content
      }];
    }
  };
}
