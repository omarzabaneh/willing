import dotenv from 'dotenv';
import zod from 'zod';

import { createTempDir } from './tests/helpers/tempDir.ts';

dotenv.config({
  quiet: true,
  path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
});

const deriveUploadDirFromLegacyCVDir = (cvUploadDir: string | undefined): string | undefined => {
  if (!cvUploadDir) return undefined;

  const normalized = cvUploadDir.replace(/[\\/]+$/, '');
  const lastSeparatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));

  if (lastSeparatorIndex < 0) return undefined;

  return normalized.slice(0, lastSeparatorIndex);
};

const env = {
  ...process.env,
  UPLOAD_DIR: process.env.UPLOAD_DIR ?? deriveUploadDirFromLegacyCVDir(process.env.CV_UPLOAD_DIR),
  CERTIFICATE_VERIFICATION_SECRET: process.env.CERTIFICATE_VERIFICATION_SECRET,
};

const optionalInDev = <T>(schema: zod.ZodType<T>): zod.ZodType<T> =>
  zod.preprocess((val: unknown) => (val === '' ? undefined : val), schema);

const schema = zod.object({
  NODE_ENV: zod.enum(['development', 'production', 'test']).default('development'),

  SERVER_PORT: zod.string().regex(/[0-9]+/),
  CLIENT_URL: zod.url().refine((url: string) => !url.endsWith('/'), {
    message: 'The client url should not end with a trailing slash',
  }),

  POSTGRES_HOST: zod.string().min(1),
  POSTGRES_DB: zod.string().min(1),
  POSTGRES_USER: zod.string().min(1),
  POSTGRES_PASSWORD: zod.string().min(1),
  POSTGRES_PORT: zod.coerce.number(),
  POSTGRES_SCHEMA: zod.string().min(1),

  JWT_SECRET: zod.string().min(1),
  CERTIFICATE_VERIFICATION_SECRET: zod.string().min(1),
  UPLOAD_DIR: zod.string(),

  WILLING_SENDER_EMAIL: optionalInDev(zod.email().optional()),

  RESEND_API_KEY: optionalInDev(zod.string().startsWith('re_').optional()),
  OPENAI_API_KEY: optionalInDev(zod.string().optional()),
  LOCATION_IQ_API_KEY: optionalInDev(zod.string().optional()),
})
  .superRefine((values: Record<string, unknown>, ctx: zod.RefinementCtx) => {
    if (values.NODE_ENV !== 'production') return;

    const prodRequired: (keyof typeof values)[] = [
      'WILLING_SENDER_EMAIL', 'RESEND_API_KEY', 'LOCATION_IQ_API_KEY', 'OPENAI_API_KEY',
    ];

    prodRequired.forEach((key) => {
      if (!values[key]) {
        ctx.addIssue({
          code: 'invalid_type',
          path: [String(key)],
          expected: 'string',
          received: 'undefined',
          message: `${key} is required in production`,
        });
      }
    });
  });

const config = schema.parse(env);

const workerId = process.env.VITEST_WORKER_ID || '0';

if (config.NODE_ENV === 'test') {
  config.POSTGRES_SCHEMA += '_' + workerId;
  config.UPLOAD_DIR = await createTempDir();
}

export default config;
