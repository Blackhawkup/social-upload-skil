import fs from 'node:fs';
import { sanitizeErrorMessage } from '../security/redact.js';

function loadFramesBase64(keyframes = [], maxFrames = 4) {
  const result = [];
  for (const kf of keyframes.slice(0, maxFrames)) {
    try {
      if (kf?.path && fs.existsSync(kf.path)) {
        const b64 = fs.readFileSync(kf.path).toString('base64');
        result.push({
          timestampSec: kf.timestampSec,
          mimeType: 'image/jpeg',
          base64: b64,
        });
      }
    } catch {
      // Skip unreadable frame
    }
  }
  return result;
}

export function extractJsonObject(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty AI model response');
  }
  const trimmed = rawText.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('AI response did not contain a JSON object');
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

export class AIProviderRouter {
  constructor({ fetchImpl = fetch, logger = null } = {}) {
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  async generateStructuredJson({ aiConfig, systemPrompt, userPrompt, keyframes = [] }) {
    const mode = (aiConfig.provider || 'auto').toLowerCase();
    const frames = loadFramesBase64(keyframes, 4);

    const candidates = [];
    if (mode === 'auto') {
      if (aiConfig.geminiApiKey) candidates.push('gemini');
      if (aiConfig.openaiApiKey) candidates.push('openai');
      if (aiConfig.anthropicApiKey) candidates.push('anthropic');
      if (aiConfig.ollamaBaseUrl) candidates.push('ollama');
    } else if (mode !== 'deterministic') {
      candidates.push(mode);
    }

    for (const provider of candidates) {
      try {
        if (provider === 'gemini' && aiConfig.geminiApiKey) {
          const json = await this.#callGemini({ aiConfig, systemPrompt, userPrompt, frames });
          return { provider: `gemini:${aiConfig.geminiModel}`, data: json };
        }
        if (provider === 'openai' && aiConfig.openaiApiKey) {
          const json = await this.#callOpenAI({ aiConfig, systemPrompt, userPrompt, frames });
          return { provider: `openai:${aiConfig.openaiModel}`, data: json };
        }
        if (provider === 'anthropic' && aiConfig.anthropicApiKey) {
          const json = await this.#callAnthropic({ aiConfig, systemPrompt, userPrompt, frames });
          return { provider: `anthropic:${aiConfig.anthropicModel}`, data: json };
        }
        if (provider === 'ollama' && aiConfig.ollamaBaseUrl) {
          const json = await this.#callOllama({ aiConfig, systemPrompt, userPrompt, frames });
          return { provider: `ollama:${aiConfig.ollamaModel}`, data: json };
        }
      } catch (err) {
        this.logger?.warn('AI provider failed; trying next fallback', {
          provider,
          error: sanitizeErrorMessage(err),
        });
      }
    }

    return null;
  }

  async #callGemini({ aiConfig, systemPrompt, userPrompt, frames }) {
    const model = aiConfig.geminiModel || 'gemini-2.5-flash';
    const parts = [{ text: `${systemPrompt}\n\n${userPrompt}` }];
    for (const f of frames) {
      parts.push({
        inlineData: {
          mimeType: f.mimeType,
          data: f.base64,
        },
      });
    }

    const res = await this.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Gemini API HTTP ${res.status}: ${sanitizeErrorMessage(data?.error?.message || res.statusText)}`);
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    return extractJsonObject(text);
  }

  async #callOpenAI({ aiConfig, systemPrompt, userPrompt, frames }) {
    const content = [{ type: 'text', text: userPrompt }];
    for (const f of frames) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${f.mimeType};base64,${f.base64}`, detail: 'low' },
      });
    }

    const res = await this.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aiConfig.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: aiConfig.openaiModel || 'gpt-4o-mini',
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content },
        ],
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`OpenAI API HTTP ${res.status}: ${sanitizeErrorMessage(data?.error?.message || res.statusText)}`);
    }
    const text = data.choices?.[0]?.message?.content || '';
    return extractJsonObject(text);
  }

  async #callAnthropic({ aiConfig, systemPrompt, userPrompt, frames }) {
    const content = [];
    for (const f of frames) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: f.mimeType, data: f.base64 },
      });
    }
    content.push({ type: 'text', text: userPrompt });

    const res = await this.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': aiConfig.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: aiConfig.anthropicModel || 'claude-3-5-sonnet-latest',
        max_tokens: 1400,
        temperature: 0.4,
        system: systemPrompt,
        messages: [{ role: 'user', content }],
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Anthropic API HTTP ${res.status}: ${sanitizeErrorMessage(data?.error?.message || res.statusText)}`);
    }
    const text = (data.content || []).map((b) => b.text || '').join('');
    return extractJsonObject(text);
  }

  async #callOllama({ aiConfig, systemPrompt, userPrompt, frames }) {
    const baseUrl = String(aiConfig.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const model = aiConfig.ollamaModel || 'qwen3:8b';
    const isVisionModel = /llava|vision|vl|minicpm|gemma3|llama3\.2-vision/i.test(model);

    const userMessage = {
      role: 'user',
      content: userPrompt,
    };
    if (isVisionModel && frames.length > 0) {
      userMessage.images = frames.map((f) => f.base64);
    }

    const res = await this.fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: systemPrompt },
          userMessage,
        ],
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${sanitizeErrorMessage(data?.error || res.statusText)}`);
    }
    return extractJsonObject(data.message?.content || '');
  }
}

