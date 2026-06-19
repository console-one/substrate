/**
 * lambdas/office-space-agent/handler.ts — AWS Lambda deployment entry.
 *
 * This file is the module AWS Lambda loads at cold start. The
 * runtime reads `Handler: lambdas/office-space-agent/handler.handler`
 * from the function's configuration and imports this exact file.
 * The export name must be `handler`; it re-exports `lambdaHandler`
 * from the env adapter under that canonical name.
 *
 * Keep this file a pure re-export. All runtime logic lives in
 * `src/env/lambda.ts` so the unit tests can import `lambdaHandler`
 * and `runLambdaEnv` directly without going through the Lambda
 * loader. Any deployment-specific concerns (CloudWatch structured
 * logging, X-Ray instrumentation, IAM role context) would be
 * wrappers around the re-exported handler, not inline code here.
 *
 * Build path for deployment: `npm run build` compiles this to
 * `dist/lambdas/office-space-agent/handler.js`; the zip upload
 * package points AWS at that compiled output.
 */

export { lambdaHandler as handler } from '../../src/env/lambda';
