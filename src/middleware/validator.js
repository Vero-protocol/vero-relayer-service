const { z } = require('zod');

// ---------------------------------------------------------------------------
// TaskPayload schema – strictly whitelisted properties only (Zod)
// ---------------------------------------------------------------------------

const LabelSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string().min(1, 'Label name must be a non-empty string'),
}).strip();

const PullRequestSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  node_id: z.string().optional(),
  number: z.number().int('PR number must be an integer').positive('PR number must be positive'),
  merged: z.boolean({ required_error: 'merged is required', invalid_type_error: 'merged must be a boolean' }),
  labels: z.array(LabelSchema).default([]),
}).strip();

const RepositorySchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string().optional(),
  full_name: z.string().optional(),
}).strip();

const TaskPayloadSchema = z.object({
  action: z.string({ required_error: 'action is required' }).trim().min(1, 'action must be a non-empty string'),
  pull_request: PullRequestSchema,
  repository: RepositorySchema.nullable().optional(),
}).strip();

/**
 * Validate an incoming payload against the TaskPayload schema.
 * Call this before handing the payload to the ingest/queue layer.
 *
 * @param {unknown} payload - Raw request body
 * @returns {{ success: true, data: any } | { success: false, errors: { path: string, message: string }[] }}
 */
function validate(payload) {
  const result = TaskPayloadSchema.safeParse(payload);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = [];
  for (const issue of result.error.errors) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        errors.push({
          path: issue.path.concat(key).join('.'),
          message: `Unrecognized key '${key}'`,
        });
      }
    } else {
      errors.push({
        path: issue.path.join('.'),
        message: issue.message,
      });
    }
  }

  return { success: false, errors };
}

/**
 * Express middleware — validates req.body against the TaskPayload schema.
 * Responds 400 Bad Request with { error, details[] } on failure.
 * Replaces req.body with the validated, coerced payload on success.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validateTaskPayload(req, res, next) {
  const result = validate(req.body);

  if (!result.success) {
    res.status(400).json({
      error: 'Invalid webhook payload',
      details: result.errors,
    });
    return;
  }

  req.body = result.data;
  next();
}

module.exports = {
  validate,
  validateTaskPayload,
  TaskPayloadSchema
};
