import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { ChatModel } from '../llm/model.ts';
import { type MemoryUpdate, memoryUpdate, type Profile } from '../memory/profile.ts';
import { rememberPrompt } from './prompts.ts';

const extraction = z.object({ updates: z.array(memoryUpdate) });

/** Asks the model which profile changes the traveller's latest message calls for. */
export async function decideUpdates(
  model: ChatModel,
  profile: Profile,
  latest: string,
  previousReply?: string,
): Promise<MemoryUpdate[]> {
  const { updates } = await model.extract(extraction, [
    new SystemMessage(rememberPrompt(profile)),
    ...(previousReply ? [new HumanMessage(`(Assistant's previous message, for context only)\n${previousReply}`)] : []),
    new HumanMessage(`Traveller's latest message:\n${latest}`),
  ]);
  return updates;
}
