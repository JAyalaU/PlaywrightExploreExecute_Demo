import { z } from 'zod';

/** Trusted source URL shape; this schema grants no public-target approval. */
export const ApprovedAbsoluteUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username && !url.password && !value.includes('*');
}, 'Expected an absolute HTTP(S) URL without credentials');

export const ExecutionProfileRefSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
});
