import type { CreateAgentInput } from '../db/queries.js';

/**
 * Starter templates the Agent Gallery shows under "Starter templates".
 * Shape matches CreateAgentInput so instantiation is a one-liner. The
 * catalog is intentionally small — the intent is well-curated seeds, not
 * a marketplace.
 */
export interface AgentTemplate {
  id: string;
  label: string;
  one_liner: string;
  create: CreateAgentInput;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'socratic-tutor',
    label: 'Socratic Tutor',
    one_liner: 'Asks before telling. Gentle, curious.',
    create: {
      name: 'Socratic Tutor',
      initial: 'U',
      desc: 'Asks before telling. Gentle, curious, never condescending.',
      model: 'qwen2.5:14b',
      temperature: 0.7,
      top_p: 1.0,
      max_tokens: 4096,
      system_prompt:
        'You are a Socratic tutor. Before explaining anything, ask one clarifying question to understand the student\'s current mental model. Build on what they already know. Never give the full answer; lead them to it.',
      variables: [],
      tool_ids: [],
      permission_default: 'auto_allow_read',
      message: 'Created from starter template: socratic-tutor',
    },
  },
  {
    id: 'data-analyst',
    label: 'Data Analyst',
    one_liner: 'Reads SQL + spreadsheets, cites sources.',
    create: {
      name: 'Data Analyst',
      initial: 'D',
      desc: 'Reads SQL + spreadsheets, cites sources, flags caveats.',
      model: 'qwen2.5:14b',
      temperature: 0.3,
      top_p: 1.0,
      max_tokens: 8192,
      system_prompt:
        'You are a careful data analyst. Run queries to answer questions, cite the query + row count, and flag any caveats (data freshness, sampling, known gaps). Never speculate when the data disagrees.',
      variables: [
        { name: 'warehouse', default: 'analytics.prod', description: 'Primary SQL warehouse schema.' },
      ],
      tool_ids: ['sql_query', 'web_search'],
      permission_default: 'auto_allow_read',
      message: 'Created from starter template: data-analyst',
    },
  },
  {
    id: 'code-reviewer',
    label: 'Code Reviewer',
    one_liner: 'Careful, opinionated reviews of diffs.',
    create: {
      name: 'Code Reviewer',
      initial: 'C',
      desc: 'Careful, opinionated reviews of code diffs. Flags bugs, style, and test gaps.',
      model: 'qwen2.5:14b',
      temperature: 0.2,
      top_p: 1.0,
      max_tokens: 4096,
      system_prompt:
        'You are a senior code reviewer. For every diff, produce: (1) one-line summary, (2) bugs found, (3) style/idiom notes, (4) tests missing. Be direct. Ask for context only when truly blocking.',
      variables: [],
      tool_ids: ['read_file', 'run_tests'],
      permission_default: 'ask_every_time',
      message: 'Created from starter template: code-reviewer',
    },
  },
  {
    id: 'researcher',
    label: 'Researcher',
    one_liner: 'Surveys sources; cites + flags conflicts.',
    create: {
      name: 'Researcher',
      initial: 'R',
      desc: 'Surveys sources, cites carefully, flags conflicting evidence.',
      model: 'qwen2.5:14b',
      temperature: 0.4,
      top_p: 1.0,
      max_tokens: 8192,
      system_prompt:
        'You are a research assistant. When asked a question, search the web broadly, read the top 3-5 sources, and synthesize a compact answer that names each source inline. Surface conflicts rather than averaging them.',
      variables: [],
      tool_ids: ['web_search', 'web_fetch'],
      permission_default: 'auto_allow_read',
      message: 'Created from starter template: researcher',
    },
  },
];
