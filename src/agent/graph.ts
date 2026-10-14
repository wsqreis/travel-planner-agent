import { AIMessage, type BaseMessage, RemoveMessage, SystemMessage } from '@langchain/core/messages';
import { Annotation, type BaseCheckpointSaver, END, messagesStateReducer, START, StateGraph } from '@langchain/langgraph';
import type { ChatModel } from '../llm/model.ts';
import type { MemoryUpdate } from '../memory/profile.ts';
import type { ProfileStore } from '../memory/store.ts';
import { assistantPrompt, summaryPrompt } from './prompts.ts';
import { decideUpdates } from './remember.ts';

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  userId: Annotation<string>(),
  /** Rolling summary of messages that were dropped from the context window. */
  summary: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  /** Profile changes made in this turn, for the UI. */
  remembered: Annotation<MemoryUpdate[]>({ reducer: (_, next) => next, default: () => [] }),
});
type State = typeof AgentState.State;
type Update = typeof AgentState.Update;

export type AgentOptions = {
  /** Above this many messages, older ones are summarised and removed. */
  maxMessages?: number;
  /** Messages kept verbatim after summarising. */
  keepMessages?: number;
  today?: () => string;
};

const text = (message: BaseMessage | undefined) =>
  typeof message?.content === 'string' ? message.content : '';

export function buildAgent(model: ChatModel, profiles: ProfileStore, checkpointer?: BaseCheckpointSaver, options: AgentOptions = {}) {
  const maxMessages = options.maxMessages ?? 12;
  const keepMessages = options.keepMessages ?? 4;
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));

  async function respond(state: State): Promise<Update> {
    const profile = profiles.get(state.userId);
    const reply = await model.reply([
      new SystemMessage(assistantPrompt(profile, state.summary, today())),
      ...state.messages,
    ]);
    return { messages: [new AIMessage(reply)] };
  }

  /** Runs in parallel with `respond`: deciding what to remember adds no latency to the reply. */
  async function remember(state: State): Promise<Update> {
    const latest = state.messages.at(-1);
    const previousReply = state.messages.slice(0, -1).findLast((m) => m.type === 'ai');
    try {
      const updates = await decideUpdates(
        model,
        profiles.get(state.userId),
        text(latest),
        previousReply && text(previousReply),
      );
      const { applied } = profiles.update(state.userId, updates);
      return { remembered: applied };
    } catch (error) {
      // Memory is best effort: a failed extraction must never cost the traveller their reply.
      console.warn(`[memory] extraction failed: ${error instanceof Error ? error.message : error}`);
      return { remembered: [] };
    }
  }

  /** Keeps the context bounded: older messages become a short summary. */
  async function compact(state: State): Promise<Update> {
    if (state.messages.length <= maxMessages) return {};
    let cut = state.messages.length - keepMessages;
    // Start the kept window on a traveller message, so it reads as a conversation.
    while (cut > 0 && state.messages[cut]?.type !== 'human') cut--;
    const older = state.messages.slice(0, cut);
    if (older.length === 0) return {};

    const summary = await model.reply([new SystemMessage(summaryPrompt(state.summary)), ...older]);
    return {
      summary: summary.trim(),
      messages: older.map((message) => new RemoveMessage({ id: message.id! })),
    };
  }

  return new StateGraph(AgentState)
    .addNode('respond', respond)
    .addNode('remember', remember)
    .addNode('compact', compact)
    .addEdge(START, 'respond')
    .addEdge(START, 'remember')
    .addEdge(['respond', 'remember'], 'compact')
    .addEdge('compact', END)
    .compile({ checkpointer });
}

export type Agent = ReturnType<typeof buildAgent>;
