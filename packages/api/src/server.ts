import express from 'express';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';
import { registerRoutes } from './routes';
import { OpenAiLlmClient, AzureOpenAiLlmClient } from '@devops-ai-reviewer/core';

// Use dotenv to load environment variables from .env file in development.
import dotenv from 'dotenv';
// Load .env only in non-production environments.
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

/** Chooses OpenAI vs Azure OpenAI based on environment variables. */
function createLlmClient() {
  // Load configuration from environment variables.
  const apiKey = process.env.OPENAI_API_KEY;
  // Azure OpenAI specific settings.
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  // Deployment name for the Azure OpenAI model.
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  // API version for Azure OpenAI.
  const azureApiVersion = process.env.AZURE_OPENAI_API_VERSION;
  // Model to use for LLM interactions.
  const model = process.env.OPENAI_MODEL ?? 'gpt-5.1';
  // Max input tokens for OpenAI requests.
  const maxInputTokens = process.env.OPENAI_MAX_INPUT_TOKENS ? parseInt(process.env.OPENAI_MAX_INPUT_TOKENS, 10) : undefined;

  // Log the chosen configuration (mask sensitive info).
  console.log('Starting LLM client with configuration:');
  console.log(`- API KEY: ${apiKey ? apiKey.substring(0, 5) + '...' : 'Not set'}`);
  console.log(`- Model: ${model}`);

  // If Azure OpenAI settings are provided, use AzureOpenAiLlmClient.
  if (azureEndpoint && azureDeployment) {
    // Create OpenAI client configured for Azure OpenAI.
    const client = new OpenAI({
      apiKey: apiKey ?? process.env.AZURE_OPENAI_KEY,
      baseURL: `${azureEndpoint}/openai/deployments/${azureDeployment}`,
      defaultQuery: { 'api-version': azureApiVersion ?? '2024-10-21' },
      defaultHeaders: { 'api-key': apiKey ?? process.env.AZURE_OPENAI_KEY ?? '' },
    });
    // Create and return AzureOpenAiLlmClient.
    return new AzureOpenAiLlmClient(client, { model, maxInputTokens: maxInputTokens });
  }

  // Fallback to standard OpenAI client.
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required to start the API');
  }
  // Create and return OpenAiLlmClient.
  return new OpenAiLlmClient(new OpenAI({ apiKey }), { model });
}

/** Boots the Express server and attaches routes. */
async function start() {
  // Create Express app.
  const app = express();
  // Configure body parser middleware.
  app.use(bodyParser.json({ limit: '1mb' }));

  // Create LLM client.
  const llmClient = createLlmClient();
  // Register API routes.
  registerRoutes(app, llmClient);

  // Start listening on the specified port.
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  // Launch the server.
  app.listen(port, () => {
    console.log(`API listening on port ${port}`);
  });
}

/**
 * Entry point: starts the server.
 */
start().catch((err) => {
  // Log any startup errors and exit.
  console.error(err.message || err);
  // Exit with failure code.
  process.exit(1);
});
