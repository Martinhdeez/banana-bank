// K8: local fake of the OpenAI API (OPENAI_BASE_URL). Embeddings are one fixed vector; each
// /responses body is recorded and answered by the next scripted turn, else by `fallback`.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
export type ModelBody = {
  instructions: string;
  input: { type?: string; role?: string; content?: string; output?: string }[];
  tools: { name: string }[];
};
export const say = (text: string) => ({
  type: 'message',
  id: 'msg_fake',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});
export const call = (name: string, args: object) => ({
  type: 'function_call',
  id: `fc_${name}`,
  call_id: `call_${name}_${Math.random().toString(36).slice(2)}`,
  name,
  arguments: JSON.stringify(args),
  status: 'completed',
});
export async function fakeOpenAI(fallback: (body: ModelBody) => object) {
  const modelRequests: ModelBody[] = [],
    embeddingInputs: string[] = [],
    script: ((body: ModelBody) => object)[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/embeddings')) {
      const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
      embeddingInputs.push(...inputs);
      const embedding = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
      return res.end(
        JSON.stringify({
          object: 'list',
          model: body.model,
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
    }
    modelRequests.push(body);
    // TR1: a scripted answer may carry the `usage` the provider would report, or be `{ fail }`,
    // an HTTP status the fake answers with (not retried by the client).
    const { usage, fail, ...item } = (script.shift()?.(body) ?? fallback(body)) as {
      usage?: object;
      fail?: number;
    };
    if (fail) {
      res.writeHead(fail, { 'x-should-retry': 'false' });
      return res.end(JSON.stringify({ error: { message: 'scripted failure' } }));
    }
    res.end(
      JSON.stringify({
        id: 'resp_fake',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: 'fake-model',
        output: [item],
        usage: usage ?? { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OPENAI_API_KEY = 'test-fake';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { server, modelRequests, embeddingInputs, script };
}
