import { Application, Request, Response } from 'express';
import { reviewCode, ReviewInput } from '@devops-ai-reviewer/core';
import { LlmClient } from '@devops-ai-reviewer/core';

/** Registers API endpoints. Currently only exposes POST /review. */
export function registerRoutes(app: Application, llmClient: LlmClient) {
  // POST /review endpoint to review code changes.
  app.post('/review', async (req: Request, res: Response) => {
    try {
      // Parse input from request body.
      const input = req.body as ReviewInput;
      // Validate input.
      if (!input?.files?.length) {
        return res.status(400).json({ error: 'files are required' });
      }
      // Call core reviewCode function.
      const report = await reviewCode(input, llmClient);
      // Return the review report as JSON.
      res.json(report);
    } catch (error: any) {
      // Log the error for debugging.
      console.error('Error in /review endpoint:', error);
      // Handle errors and return 500 status.
      res.status(500).json({ error: error?.message ?? 'Unexpected error' });
    }
  });
}
