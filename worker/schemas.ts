import { CHAT_TONES } from '../src/game/claudeProtocol.ts';


export const CHAT_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['segments', 'tip', 'tone'],
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['lang', 'text', 'gloss'],
        properties: {
          lang: { type: 'string', enum: ['ja', 'zh'] },
          text: { type: 'string' },
          gloss: { type: 'string' },
        },
      },
    },
    tip: { type: 'string' },
    tone: { type: 'string', enum: [...CHAT_TONES] },
  },
} as const;

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, feedback: { type: 'string' } },
  required: ['ok', 'feedback'],
  additionalProperties: false,
} as const;

export const TIP_FIX_SCHEMA = {
  type: 'object',
  properties: { tip: { type: 'string' } },
  required: ['tip'],
  additionalProperties: false,
} as const;

export const LOOKUP_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ja: { type: 'string' },
          zh: { type: 'string' },
          level: { type: 'string', enum: ['N5', 'N4', 'N3', 'N2', 'N1', '級外'] },
          note: { type: 'string' },
        },
        required: ['ja', 'zh', 'level', 'note'],
        additionalProperties: false,
      },
    },
    grammar: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          level: { type: 'string', enum: ['N5', 'N4', 'N3', 'N2', 'N1', '級外'] },
          explain: { type: 'string' },
        },
        required: ['point', 'level', 'explain'],
        additionalProperties: false,
      },
    },
    examples: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ja: { type: 'string' }, zh: { type: 'string' } },
        required: ['ja', 'zh'],
        additionalProperties: false,
      },
    },
    message: { type: 'string' },
  },
  required: ['items', 'grammar', 'examples', 'message'],
  additionalProperties: false,
} as const;
