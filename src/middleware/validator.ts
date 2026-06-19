import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';

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

export const TaskPayloadSchema = z.object({
  action: z.string({ required_error: 'action is required' }).trim().min(1, 'action must be a non-empty string'),
  pull_request: PullRequestSchema,
  repository: RepositorySchema.nullable().optional(),
}).strip();

export type TaskPayload = z.infer<typeof TaskPayloadSchema>;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

export interface ValidationSuccess {
  success: true;
  data: TaskPayload;
}

export interface ValidationErrorDetail {
  path: string;
  message: string;
}

export interface ValidationFailure {
  success: false;
  errors: ValidationErrorDetail[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Validate an incoming payload against the TaskPayload schema.
 * Call this before handing the payload to the ingest/queue layer.
 *
 * @param payload - Raw request body (unknown shape)
 * @returns ValidationResult – either the parsed+coerced data or a list of errors
 */
export function validate(payload: unknown): ValidationResult {
  const result = TaskPayloadSchema.safeParse(payload);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors: ValidationErrorDetail[] = [];
  for (const issue of result.error.errors) {
    if (issue.code === 'unrecognized_keys') {
      const unrecognizedKeys = (issue as any).keys as string[];
      for (const key of unrecognizedKeys) {
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

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that validates req.body against TaskPayloadSchema.
 * Responds with 400 Bad Request and structured error details on failure.
 * Attaches the validated, coerced payload back to req.body on success.
 */
export function validateTaskPayload(req: Request, res: Response, next: NextFunction): void {
  const result = validate(req.body);

  if (!result.success) {
    res.status(400).json({
      error: 'Invalid webhook payload',
      details: result.errors,
    });
    return;
  }

  // Replace req.body with the validated, coerced payload so downstream
  // handlers can rely on correct types without re-parsing.
  req.body = result.data;
  next();
}
