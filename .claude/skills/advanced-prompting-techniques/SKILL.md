---
name: advanced-prompting-techniques
description: Structured output JSON schemas, extended thinking, and tool-use loop patterns used in this pipeline
---

# Advanced Prompting Techniques

## Structured Output via Tools (preferred over text extraction)

Use Claude's `tools` parameter + `tool_choice` to guarantee structured JSON output.
This eliminates brittle regex-on-fenced-code-blocks extraction.

### Pattern: Force a single required tool call

```javascript
const response = await client.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 16000,
  thinking: { type: 'enabled', budget_tokens: 8000 },
  system: systemPrompt,
  messages: userMessages,
  tools: [MY_OUTPUT_TOOL],
  tool_choice: { type: 'tool', name: 'my_output_tool' },
});

// Extract from tool_use block — guaranteed structured
const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'my_output_tool');
const result = toolBlock?.input; // typed, validated JSON
```

### Pattern: Final synthesis tool in a multi-turn loop

```javascript
const TOOLS = [
  { name: 'ask_data_source', ... },
  { name: 'search_knowledge', ... },
  {
    name: 'synthesize_output',
    description: 'Call this ONCE when done gathering data. Do NOT output JSON as text.',
    input_schema: { type: 'object', properties: { ... }, required: [...] },
  },
];

// In the loop:
if (response.stop_reason === 'tool_use') {
  const synthesizeBlock = toolBlocks.find(b => b.name === 'synthesize_output');
  if (synthesizeBlock) {
    return { structured: synthesizeBlock.input }; // exit loop with typed result
  }
  // otherwise execute data-gathering tools and continue loop
}
```

### Why This Beats Text Extraction

| | Text extraction | Tool schema |
|---|---|---|
| Parse failure | Silent / partial data | API error with clear message |
| Schema drift | Invisible | Caught at call time |
| Nested objects | Fragile regex | Guaranteed structure |
| Booleans/numbers | String coercion risk | Native types preserved |

## Extended Thinking

- Already implemented in `generate-script.js` at `budget_tokens: 8000`
- Compatible with `tools` + `tool_choice` — model thinks, then calls the required tool
- Do NOT lower below 4096 tokens for complex generation tasks
- Thinking blocks appear before text/tool_use blocks in `response.content`

### Combining thinking + tool_choice

```javascript
const response = await client.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 16000,
  thinking: { type: 'enabled', budget_tokens: 8000 },
  tools: [STRUCTURED_OUTPUT_TOOL],
  tool_choice: { type: 'tool', name: 'structured_output_tool' },
  // ...
});
// Model thinks → then calls the required tool
// response.content order: [thinking_block, tool_use_block]
```

## Multi-Turn Tool-Use Loop Pattern

```javascript
const messages = [...initialMessages];
while (true) {
  const response = await client.messages.create({ model, max_tokens, system, tools, messages });

  if (response.stop_reason === 'end_turn') {
    // Process final text response
    break;
  }

  if (response.stop_reason === 'tool_use') {
    const toolBlocks = response.content.filter(b => b.type === 'tool_use');

    // Check for terminal tool first
    const terminal = toolBlocks.find(b => b.name === 'synthesize_output');
    if (terminal) return terminal.input;

    // Add assistant message
    messages.push({ role: 'assistant', content: response.content });

    // Execute tools in parallel
    const results = await Promise.all(toolBlocks.map(async block => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: await executeTool(block.name, block.input),
    })));

    messages.push({ role: 'user', content: results });
  }
}
```

## Tool Schema Design

### Good tool schema structure

```javascript
{
  name: 'generate_demo_script',
  description: 'Call this once to output the final demo script. Do NOT output JSON as text.',
  input_schema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id:       { type: 'string', description: 'kebab-case identifier' },
            narration: { type: 'string', description: '20-35 words for TTS' },
            durationHintMs: { type: 'number' },
            // ...
          },
          required: ['id', 'narration', 'durationHintMs'],
        },
      },
    },
    required: ['steps'],
  },
}
```

### Tips for schema design

- Always include `description` on array items and key fields — Claude uses these to fill values correctly
- Use `required` arrays to prevent omissions
- Be specific: `"20-35 words for ElevenLabs TTS"` is better than `"narration text"`
- For enums: use `enum: ['launch', 'credentials', 'select-account']` not just `type: 'string'`
- Tool descriptions should say when NOT to use the tool as well as when to use it

## Pipeline Models

| Stage | Model | Reasoning |
|---|---|---|
| generate-script.js | claude-opus-4-7 + thinking 8k | Complex multi-step planning |
| research.js | claude-opus-4-7 | Tool-use loop, quality over speed |
| qa-review.js | claude-haiku-4-5-20251001 | Fast, high-volume QA scoring |
| plaid-browser-agent.js | claude-haiku-4-5-20251001 | Vision, latency-sensitive |
| orchestrator critique | claude-haiku-4-5-20251001 | Value-prop claim check, fast |
