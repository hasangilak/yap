import { describe, expect, it } from 'vitest';
import { parseTextualWebSearchCall } from '../../src/runtime/graph/model.js';

describe('textual web-search fallback', () => {
  it('recognizes function-style output', () => {
    expect(parseTextualWebSearchCall('I will look.\n\nweb_search("latest market news")')).toEqual({
      name: 'web_search',
      args: { query: 'latest market news' },
    });
  });

  it('recognizes an Ollama JSON tool envelope after narration', () => {
    expect(
      parseTextualWebSearchCall(
        'Searching now:\n{ "name": "web_search", "arguments": { "query": "Nasdaq today" } }',
      ),
    ).toEqual({ name: 'web_search', args: { query: 'Nasdaq today' } });
  });

  it('never promotes a side-effectful textual tool request', () => {
    expect(
      parseTextualWebSearchCall(
        '{ "name": "write_file", "arguments": { "path": "x", "content": "y" } }',
      ),
    ).toBeNull();
  });

  it('leaves ordinary prose and malformed calls alone', () => {
    expect(parseTextualWebSearchCall('You can call web_search when needed.')).toBeNull();
    expect(parseTextualWebSearchCall('{ "name": "web_search", "arguments": {} }')).toBeNull();
  });
});
