import { webBack, webClick, webGoto, webSearch, webType } from './browser.js';

export type ToolSchema = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

export const toolSchemas: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web via DuckDuckGo and return the results as a numbered accessibility tree. Use this as your first step whenever you need current information, a source to cite, or facts you are not highly confident about.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_goto',
      description:
        'Navigate directly to a specific URL and return the page contents as a numbered accessibility tree. Use this when you already know the URL; otherwise prefer web_search.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to open, including the https:// prefix.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_click',
      description:
        'Click the interactive element tagged [N] from the most recent page output. Returns the page contents after the click.',
      parameters: {
        type: 'object',
        properties: {
          element_id: {
            type: 'integer',
            description:
              'The [N] id of the element to click, as shown in the last accessibility tree.',
          },
        },
        required: ['element_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_type',
      description:
        'Type text into the input tagged [N] from the most recent page output. Set submit to true to press Enter after typing, which is usually what you want for search boxes. Returns the page contents after the action.',
      parameters: {
        type: 'object',
        properties: {
          element_id: {
            type: 'integer',
            description: 'The [N] id of the input element.',
          },
          text: { type: 'string', description: 'The text to type.' },
          submit: {
            type: 'boolean',
            description: 'Press Enter after typing. Defaults to false.',
          },
        },
        required: ['element_id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_back',
      description:
        'Go back one step in browser history. Returns the previous page contents.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'web_search': {
      const query = String(args.query ?? '');
      if (!query) throw new Error('web_search requires a non-empty query');
      return webSearch(query);
    }
    case 'web_goto': {
      const url = String(args.url ?? '');
      if (!url) throw new Error('web_goto requires a url');
      return webGoto(url);
    }
    case 'web_click': {
      const id = Number(args.element_id);
      if (!Number.isInteger(id)) throw new Error('web_click requires an integer element_id');
      return webClick(id);
    }
    case 'web_type': {
      const id = Number(args.element_id);
      const text = String(args.text ?? '');
      const submit = args.submit === true;
      if (!Number.isInteger(id)) throw new Error('web_type requires an integer element_id');
      return webType(id, text, submit);
    }
    case 'web_back':
      return webBack();
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
