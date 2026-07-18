import fsp from 'node:fs/promises';
import path from 'node:path';

export async function loadSchemas(toolRoot) {
  // Lazy import keeps the CLI (notably `doctor`) usable before npm install.
  const { default: Ajv } = await import('ajv');
  const authorFile = path.join(toolRoot, 'schemas', 'author-output.schema.json');
  const reviewerFile = path.join(toolRoot, 'schemas', 'reviewer-output.schema.json');
  const mergedReviewFile = path.join(toolRoot, 'schemas', 'merged-review.schema.json');
  const [authorSchema, reviewerSchema, mergedReviewSchema] = await Promise.all([
    fsp.readFile(authorFile, 'utf8').then(JSON.parse),
    fsp.readFile(reviewerFile, 'utf8').then(JSON.parse),
    fsp.readFile(mergedReviewFile, 'utf8').then(JSON.parse)
  ]);
  const ajv = new Ajv({ allErrors: true, strict: true });
  return {
    authorFile,
    reviewerFile,
    authorSchema,
    reviewerSchema,
    mergedReviewSchema,
    validateAuthor: ajv.compile(authorSchema),
    validateReviewer: ajv.compile(reviewerSchema),
    validateMergedReview: ajv.compile(mergedReviewSchema)
  };
}

export function validationError(label, validate) {
  const detail = (validate.errors || [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  return new Error(`${label} schema validation failed: ${detail || 'unknown validation error'}`);
}

export function validatePlanMarkdown(markdown, minimumLength = 200) {
  const text = String(markdown || '').trim();
  const missing = [];
  if (!/^#\s+\S/m.test(text)) missing.push('H1');
  for (const heading of ['## Goal', '## Implementation', '## Verification']) {
    if (!text.includes(heading)) missing.push(heading);
  }
  if (text.length < minimumLength) missing.push(`at least ${minimumLength} characters`);
  if (missing.length) throw new Error(`plan Markdown is incomplete: missing ${missing.join(', ')}`);
  return `${text}\n`;
}
