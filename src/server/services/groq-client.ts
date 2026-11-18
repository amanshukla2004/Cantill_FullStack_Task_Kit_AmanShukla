import Groq from 'groq-sdk';
import { z } from 'zod';

export interface GroqJsonResult<T> {
  ok: boolean;
  data?: T;
  model?: string;
  fallbackReason?: string;
}

export function getGroqApiKey(): string | null {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key || key === 'your_groq_api_key_here') return null;
  return key;
}

export function getGroqModel(): string {
  return process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile';
}

export class GroqClient {
  public isConfigured(): boolean {
    return getGroqApiKey() !== null;
  }

  public async completeJson<S extends z.ZodTypeAny>(
    systemPrompt: string,
    userPrompt: string,
    schema: S
  ): Promise<GroqJsonResult<z.infer<S>>> {
    const apiKey = getGroqApiKey();
    if (!apiKey) {
      return { ok: false, fallbackReason: 'GROQ_API_KEY not configured; using deterministic fallback' };
    }

    const model = getGroqModel();
    const client = new Groq({ apiKey });

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // Up to 2 attempts: second attempt includes exact Zod schema validation error for self-repair
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const completion = await client.chat.completions.create({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages
        });

        const raw = completion.choices[0]?.message?.content;
        if (!raw) {
          return { ok: false, model, fallbackReason: 'Empty response from Groq' };
        }

        const parsedJson = JSON.parse(raw);
        const validated = schema.safeParse(parsedJson);
        if (validated.success) {
          return { ok: true, data: validated.data, model };
        }

        if (attempt === 1) {
          messages.push({ role: 'assistant', content: raw });
          messages.push({
            role: 'user',
            content: `Your JSON failed schema validation with errors:\n${JSON.stringify(
              validated.error.flatten()
            )}\nPlease return ONLY corrected valid JSON matching the exact schema.`
          });
          continue;
        }

        return {
          ok: false,
          model,
          fallbackReason: `Groq JSON validation failed after retry: ${validated.error.message}`
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, model, fallbackReason: `Groq API error: ${msg}` };
      }
    }

    return { ok: false, model, fallbackReason: 'Exhausted Groq attempts' };
  }
}

export const groqClient = new GroqClient();
