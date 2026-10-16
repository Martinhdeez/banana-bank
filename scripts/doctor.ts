import { openai, embedTexts } from '../src/retrieval/embeddings';
import { config } from '../src/config';
try {
  const response = await openai().responses.create({
    model: config.chatModel,
    input: 'Reply with only: connection successful',
    reasoning: { effort: 'none' },
    max_output_tokens: 100,
    store: false,
  });
  const [vector] = await embedTexts(['Banana simulator connection check.']);
  console.log(
    JSON.stringify(
      {
        chatModel: response.model,
        reply: response.output_text,
        embeddingModel: config.embeddingModel,
        dimensions: vector.length,
        keyConfigured: true,
      },
      null,
      2,
    ),
  );
} catch (e) {
  const error = e as { status?: number; code?: string };
  console.error(
    JSON.stringify({
      ok: false,
      status: error.status || null,
      code: error.code || 'connection_or_configuration_error',
      hint: 'Check OPENAI_API_KEY, access to both models, quota, and connectivity.',
    }),
  );
  process.exitCode = 1;
}
