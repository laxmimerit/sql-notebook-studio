// The AI layer, built on LangChain. Every provider is a LangChain chat model,
// so the rest of the extension only sees `streamText` and `listModels`.
// Bundled separately (dist/ai.js) and loaded on first use.

import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenRouter } from '@langchain/openrouter';
import { ChatOllama } from '@langchain/ollama';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type Provider = 'openai' | 'anthropic' | 'openrouter' | 'ollama' | 'custom';

export interface AiConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-6.1-sol',
  anthropic: 'claude-sonnet-5-5',
  openrouter: 'openrouter/auto',
  ollama: '',
  custom: '',
};

export const DEFAULT_BASE_URL: Partial<Record<Provider, string>> = {
  ollama: 'http://localhost:11434',
};

const SITE = { siteUrl: 'https://marketplace.visualstudio.com/items?itemName=kgptalkie.sql-notebook', siteName: 'SQL Notebook Studio' };

export function createModel(cfg: AiConfig): BaseChatModel {
  const model = cfg.model || DEFAULT_MODELS[cfg.provider];
  if (!model) throw new Error('Choose a model first: run "SQL Notebook Studio: Configure AI".');
  switch (cfg.provider) {
    case 'openai':
      return new ChatOpenAI({ model, apiKey: cfg.apiKey, useResponsesApi: true, maxRetries: 1 });
    case 'anthropic':
      return new ChatAnthropic({ model, apiKey: cfg.apiKey, maxTokens: 4096, maxRetries: 1 });
    case 'openrouter':
      return new ChatOpenRouter({ model, apiKey: cfg.apiKey, ...SITE } as any) as unknown as BaseChatModel;
    case 'ollama':
      return new ChatOllama({ model, baseUrl: cfg.baseUrl || DEFAULT_BASE_URL.ollama, think: false });
    case 'custom':
      if (!cfg.baseUrl) throw new Error('Set the API base URL for your custom provider (sqlNotebook.ai.baseUrl).');
      return new ChatOpenAI({ model, apiKey: cfg.apiKey || 'not-needed', configuration: { baseURL: cfg.baseUrl }, maxRetries: 1 });
  }
}

/** Streams the model's answer as text, chunk by chunk. */
export async function* streamText(cfg: AiConfig, system: string, user: string, signal?: AbortSignal): AsyncGenerator<string> {
  const model = createModel(cfg);
  const stream = await model.stream([new SystemMessage(system), new HumanMessage(user)], { signal });
  for await (const chunk of stream) {
    const c = chunk.content;
    if (typeof c === 'string') {
      if (c) yield c;
    } else if (Array.isArray(c)) {
      for (const part of c as any[]) if (part?.type === 'text' && part.text) yield part.text as string;
    }
  }
}

/** Lists model IDs from the provider. Model listing is plain REST: LangChain has no list API. */
export async function listModels(cfg: AiConfig): Promise<string[]> {
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json() as Promise<any>;
  };
  switch (cfg.provider) {
    case 'openai': {
      const j = await get('https://api.openai.com/v1/models', { Authorization: `Bearer ${cfg.apiKey}` });
      return (j.data as any[]).map((m) => m.id as string).filter((id) => /^(gpt|o\d|chatgpt)/.test(id)).sort().reverse();
    }
    case 'anthropic': {
      const j = await get('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' });
      return (j.data as any[]).map((m) => m.id as string);
    }
    case 'openrouter': {
      const j = await get('https://openrouter.ai/api/v1/models');
      return ['openrouter/auto', ...(j.data as any[]).map((m) => m.id as string)];
    }
    case 'ollama': {
      const j = await get(`${(cfg.baseUrl || DEFAULT_BASE_URL.ollama!).replace(/\/+$/, '').replace(/\/v1$/, '')}/api/tags`);
      return (j.models as any[]).map((m) => m.name as string);
    }
    case 'custom': {
      const j = await get(`${(cfg.baseUrl ?? '').replace(/\/+$/, '')}/models`, cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {});
      return ((j.data ?? j.models ?? []) as any[]).map((m) => (m.id ?? m.name) as string);
    }
  }
}
