import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { buildAgent, type AgentOptions } from '../src/agent/graph.ts';
import type { ChatModel } from '../src/llm/model.ts';
import type { MemoryUpdate } from '../src/memory/profile.ts';
import { SqliteProfileStore } from '../src/memory/store.ts';

/** Scripted ChatModel: queued memory extractions, numbered replies, and a record of every prompt. */
export class ScriptedModel implements ChatModel {
  readonly extractions: Array<MemoryUpdate[] | Error> = [];
  readonly replyCalls: BaseMessage[][] = [];
  readonly extractCalls: BaseMessage[][] = [];
  summaries = 0;

  remembers(...turns: Array<MemoryUpdate[] | Error>): this {
    this.extractions.push(...turns);
    return this;
  }

  async extract(_schema: unknown, messages: BaseMessage[]): Promise<never> {
    this.extractCalls.push(messages);
    const next = this.extractions.shift() ?? [];
    if (next instanceof Error) throw next;
    return { updates: next } as never;
  }

  async reply(messages: BaseMessage[]): Promise<string> {
    this.replyCalls.push(messages);
    if (String(messages[0]?.content).startsWith('Summarise')) return `summary #${++this.summaries}`;
    return `reply #${this.replyCalls.length}`;
  }

  /** System prompt of the n-th assistant reply (not counting summaries). */
  assistantPrompt(n: number): string {
    const calls = this.replyCalls.filter((call) => !String(call[0]?.content).startsWith('Summarise'));
    return String(calls[n]?.[0]?.content ?? '');
  }
}

export function setup(model: ScriptedModel, options: AgentOptions = {}) {
  const profiles = new SqliteProfileStore(':memory:', () => new Date('2026-10-14T09:00:00Z'));
  const agent = buildAgent(model, profiles, new MemorySaver(), { today: () => '2026-10-14', ...options });
  const chat = (userId: string, thread: string, message: string) =>
    agent.invoke({ messages: [new HumanMessage(message)], userId }, { configurable: { thread_id: thread } });
  return { profiles, agent, chat };
}
