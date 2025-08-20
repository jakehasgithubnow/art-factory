import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env.js';

// Shared Redis connection
const connection = new IORedis(env.redisUrl);

// Sensible defaults with env overrides
const ATTEMPTS = Number.parseInt(process.env.QUEUE_ATTEMPTS ?? String(env.queue?.attempts ?? 8), 10);
const BACKOFF_MS = Number.parseInt(process.env.QUEUE_BACKOFF_MS ?? String(env.queue?.backoffMs ?? 30000), 10);
const REMOVE_ON_COMPLETE = process.env.QUEUE_REMOVE_ON_COMPLETE
  ? process.env.QUEUE_REMOVE_ON_COMPLETE === 'true'
  : true;
const REMOVE_ON_FAIL = process.env.QUEUE_REMOVE_ON_FAIL
  ? process.env.QUEUE_REMOVE_ON_FAIL === 'true'
  : false;
const PREFIX = process.env.QUEUE_PREFIX || 'art-factory';

const defaultJobOptions = {
  attempts: ATTEMPTS,
  backoff: { type: 'exponential', delay: BACKOFF_MS },
  removeOnComplete: REMOVE_ON_COMPLETE,
  removeOnFail: REMOVE_ON_FAIL,
};

function createQueue(name) {
  return new Queue(name, {
    connection,
    defaultJobOptions,
    prefix: PREFIX,
  });
}

export const qCatchment = createQueue('catchment');
export const qLocation  = createQueue('location');
export const qPhoto     = createQueue('photo');
export const qArtwork   = createQueue('artwork');
export const qPublish   = createQueue('publish');

// Optionally export the shared connection for workers
export { connection };
