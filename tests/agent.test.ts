import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ScriptedModel, setup } from './helpers.ts';

describe('travel agent', () => {
  it('remembers preferences in one conversation and uses them in the next', async () => {
    const model = new ScriptedModel().remembers([
      { op: 'add', field: 'dietary', value: 'vegetarian' },
      { op: 'set', field: 'pace', value: 'relaxed' },
    ]);
    const { chat, profiles } = setup(model);

    const first = await chat('ana', 'thread-1', "I'm vegetarian and I like a relaxed pace");
    assert.equal(first.messages.at(-1)?.content, 'reply #1');
    assert.equal(first.remembered.length, 2);
    assert.deepEqual(profiles.get('ana').dietary, ['vegetarian']);

    // A brand-new conversation: no shared messages, but the profile reaches the prompt.
    const second = await chat('ana', 'thread-2', 'Plan me 3 days in Rome');
    assert.equal(second.messages.length, 2);
    assert.match(model.assistantPrompt(1), /dietary: vegetarian/);
    assert.match(model.assistantPrompt(1), /pace: relaxed/);
  });

  it('keeps each traveller’s memory separate', async () => {
    const model = new ScriptedModel().remembers([{ op: 'add', field: 'interests', value: 'diving' }]);
    const { chat } = setup(model);
    await chat('ana', 't1', 'I love diving');
    await chat('bo', 't2', 'Hi');
    assert.doesNotMatch(model.assistantPrompt(1), /diving/);
  });

  it('shows the extractor the previous reply as context, labelled as not from the traveller', async () => {
    const model = new ScriptedModel();
    const { chat } = setup(model);
    await chat('ana', 't', 'Ideas for Portugal?');
    await chat('ana', 't', 'The second one sounds great');

    const [, context, latest] = model.extractCalls[1]!;
    assert.match(String(context?.content), /^\(Assistant's previous message, for context only\)\nreply #1/);
    assert.match(String(latest?.content), /The second one sounds great/);
  });

  it('still replies when memory extraction fails', async () => {
    const model = new ScriptedModel().remembers(new Error('model returned invalid JSON'));
    const { chat } = setup(model);
    const warn = console.warn;
    console.warn = () => {};
    try {
      const state = await chat('ana', 't', 'Hello');
      assert.equal(state.messages.at(-1)?.content, 'reply #1');
      assert.deepEqual(state.remembered, []);
    } finally {
      console.warn = warn;
    }
  });

  it('summarises older messages once the conversation outgrows the window', async () => {
    const model = new ScriptedModel();
    const { chat } = setup(model, { maxMessages: 6, keepMessages: 2 });

    for (let turn = 1; turn <= 3; turn++) {
      const state = await chat('ana', 't', `message ${turn}`);
      assert.equal(state.summary, '', 'no summary while under the limit');
      assert.equal(state.messages.length, turn * 2);
    }

    const state = await chat('ana', 't', 'message 4');
    assert.equal(state.summary, 'summary #1');
    assert.deepEqual(
      state.messages.map((m) => [m.type, m.content]),
      [
        ['human', 'message 4'],
        ['ai', 'reply #4'],
      ],
    );

    await chat('ana', 't', 'message 5');
    assert.match(model.assistantPrompt(4), /Summary of the earlier part of this conversation:\nsummary #1/);
  });
});
