import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { buildAgent } from './agent/graph.ts';
import { loadConfig } from './config.ts';
import { OpenRouterModel } from './llm/model.ts';
import { describeProfile, type MemoryUpdate } from './memory/profile.ts';
import { SqliteProfileStore } from './memory/store.ts';

const HELP = `Commands:
  /memory   what I remember about you
  /history  when I learned each thing
  /forget   erase everything I remember about you
  /new      start a new conversation (memory is kept)
  /exit     quit`;

const config = loadConfig();
if (!config.llm.apiKey) {
  console.error('OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const userFlag = process.argv.indexOf('--user');
const userId = (userFlag > -1 && process.argv[userFlag + 1]) || 'me';

const profiles = new SqliteProfileStore(config.dbPath);
// Conversations are short-term memory and live in RAM; the profile is long-term and lives in SQLite.
const agent = buildAgent(new OpenRouterModel(config.llm), profiles, new MemorySaver());
let threadId = randomUUID();

const formatUpdate = ({ op, field, value }: MemoryUpdate) =>
  ({ add: `+ ${field}: ${value}`, set: `${field} = ${value}`, remove: `- ${field}: ${value}`, clear: `cleared ${field}` })[op];

const rl = createInterface({ input: stdin, output: stdout });
console.log(styleText('bold', `Wayfarer, your travel planner`) + styleText('dim', `  (user: ${userId})`));
console.log(styleText('dim', HELP) + '\n');

while (true) {
  const input = (await rl.question(styleText('cyan', 'you › '))).trim();
  if (!input) continue;

  if (input === '/exit') break;
  if (input === '/help') {
    console.log(HELP);
    continue;
  }
  if (input === '/memory') {
    console.log(describeProfile(profiles.get(userId)) + '\n');
    continue;
  }
  if (input === '/history') {
    const events = profiles.history(userId);
    console.log(events.length ? events.map((e) => `${e.at.slice(0, 16).replace('T', ' ')}  ${formatUpdate(e)}`).join('\n') : '(empty)');
    console.log();
    continue;
  }
  if (input === '/forget') {
    const sure = await rl.question('Erase everything I remember about you? (y/N) ');
    if (sure.trim().toLowerCase() === 'y') {
      profiles.forget(userId);
      threadId = randomUUID();
      console.log('Done. Your profile and its history are deleted.\n');
    }
    continue;
  }
  if (input === '/new') {
    threadId = randomUUID();
    console.log(styleText('dim', 'New conversation. I still remember your preferences.\n'));
    continue;
  }

  try {
    const state = await agent.invoke(
      { messages: [new HumanMessage(input)], userId },
      { configurable: { thread_id: threadId } },
    );
    const reply = state.messages.at(-1)?.content;
    console.log(`\n${styleText('green', 'wayfarer ›')} ${typeof reply === 'string' ? reply : ''}\n`);
    for (const update of state.remembered) console.log(styleText('dim', `  [memory] ${formatUpdate(update)}`));
    if (state.remembered.length) console.log();
  } catch (error) {
    console.error(styleText('red', `Something went wrong: ${error instanceof Error ? error.message : error}\n`));
  }
}

rl.close();
profiles.close();
