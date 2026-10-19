# travel-planner-agent

[![CI](https://github.com/wsqreis/travel-planner-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/wsqreis/travel-planner-agent/actions/workflows/ci.yml)

**Wayfarer**, a travel planning assistant that remembers you. Tell it once that you're vegetarian, hate crowds and fly out of Berlin, and every future conversation starts from there. You can always see what it remembers, when it learned it, and erase it.

Built with **LangGraph** (TypeScript), **OpenRouter** (free models by default) and SQLite via Node's built-in `node:sqlite`. No native dependencies, no database server.

Illustrative session (replies abbreviated):

```
$ npm start -- --user maya
you › Hi! I'm Maya, vegetarian, and I usually fly out of Berlin. I like slow trips.
wayfarer › Nice to meet you, Maya! ...
  [memory] name = Maya
  [memory] + dietary: vegetarian
  [memory] homeBase = Berlin
  [memory] pace = slow

$ npm start -- --user maya          # days later, a brand-new conversation
you › Ideas for a long weekend in October?
wayfarer › Since you travel slowly and fly from Berlin, I'd keep it to one city with a short flight...

you › /history
2026-10-14 09:12  name = Maya
2026-10-14 09:12  + dietary: vegetarian
...
```

## How memory works

Two kinds of memory, with different lifetimes:

| | Short-term | Long-term |
|---|---|---|
| What | The current conversation | A structured traveller profile |
| Where | LangGraph checkpointer, per `thread_id` | SQLite: `profiles` + append-only `profile_events` |
| Lifetime | One conversation | Until the traveller erases it |
| Bounded by | Rolling summary (see below) | Fixed fields with short values |

Each message runs this graph:

```
            ┌──────────┐
       ┌───▶│ respond  │──┐   reply, using the profile + conversation summary
START ─┤    └──────────┘  ├──▶ compact ──▶ END
       └───▶│ remember │──┘   decide profile changes from the latest message
            └──────────┘
```

- **respond and remember run in parallel**, so deciding what to remember adds no latency to the reply. If memory extraction fails, the traveller still gets their answer.
- **remember** returns structured operations (`set`, `add`, `remove`, `clear`) on a fixed set of fields (`name`, `homeBase`, `budget`, `pace`, `companions`, `interests`, `dietary`, `dislikes`, `visited`, `wishlist`), not free text. Corrections ("I eat fish now, so pescatarian") and forget requests ("forget the nightlife thing") become removals. Deterministic code applies the operations, removes duplicates, and logs every real change.
- **The extractor only learns from the traveller.** It sees the assistant's previous message for context ("yes, I love that!"), clearly labelled as not coming from the traveller, so destinations the assistant suggested are not stored as the traveller's preferences.
- **compact** keeps the context bounded. Above 12 messages, everything but the last two exchanges is folded into a rolling summary and removed from state with `RemoveMessage`.

### The traveller stays in control

| Command | |
|---|---|
| `/memory` | Show the profile |
| `/history` | Every change, with timestamps |
| `/forget` | Delete the profile and its history (asks for confirmation) |
| `/new` | Start a new conversation; the profile is kept |

The traveller can also ask in plain language ("forget my budget") to remove a single fact.

## Evaluation

Memory that saves the wrong things is worse than no memory. `npm run eval` runs 24 cases against a real model and checks the profile changes decided for each message:

- **Recall**: stated facts get saved (name, home base, dietary needs, places visited...).
- **Precision**: nothing else gets saved. Questions, thanks, one-off trip details and the assistant's own suggestions must leave the profile alone.
- **Updates**: corrections replace the old value, and forget requests remove it.

```bash
npm run eval                                                    # the configured model chain
npm run eval -- --models nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free   # each model on its own
npm run eval -- --only explores-suggestion,adopts-suggestion    # a subset of cases
```

A case passes only when every expected change happened and nothing unexpected did. Results are saved to `eval/results/`.

<!-- Results table: run `npm run eval` per model and paste the summary here. -->

## Run it

Requires Node.js 22.18+ and a free [OpenRouter API key](https://openrouter.ai/keys).

```bash
npm install
cp .env.example .env     # add OPENROUTER_API_KEY
npm start -- --user maya
```

The profile is stored in `memory.db` (set `MEMORY_DB_PATH` to change it).

## Tests

```bash
npm test          # no network
npm run typecheck
```

The tests cover profile operations, SQLite persistence and the audit log, and the graph with a scripted model: memory carried into a new conversation, isolation between travellers, extraction failures, and summarisation trimming the context.

## Project layout

```
src/
├── agent/
│   ├── graph.ts     # respond ∥ remember → compact
│   ├── remember.ts  # memory extraction (shared with the eval)
│   └── prompts.ts
├── memory/
│   ├── profile.ts   # profile shape, update operations, applyUpdates
│   └── store.ts     # SQLite profile store with change log
├── llm/model.ts     # ChatModel interface + OpenRouter (fallback models)
└── cli.ts
eval/                # cases.json + runner
```

## Notes and limits

- The assistant answers from the model's own knowledge; it has no live prices, availability or entry rules, and its prompt tells it to send travellers to official sources for those.
- Conversations are kept in memory, so they end when the CLI exits; the profile persists. Swapping `MemorySaver` for a persistent LangGraph checkpointer would make conversations resumable too.
- Free OpenRouter models change often and are rate limited. Set `OPENROUTER_MODELS` to whatever is available.

## License

[MIT](LICENSE)
