import { Worker } from 'bullmq';
import { randomUUID } from 'crypto';
import { connection } from './queues.js';
import catchment from '../workflows/catchment.js';
import locations from '../workflows/locations.js';
import photos from '../workflows/photos.js';
import artwork from '../workflows/artwork.js';
import publish from '../workflows/publish.js';

// Use same prefix as queues to ensure workers consume the correct streams
const PREFIX = process.env.QUEUE_PREFIX || 'art-factory';

// Per-queue concurrency (override via env)
const CONCURRENCY = {
  catchment: parseInt(process.env.CONCURRENCY_CATCHMENT || '3', 10),
  location:  parseInt(process.env.CONCURRENCY_LOCATION  || '3', 10),
  photo:     parseInt(process.env.CONCURRENCY_PHOTO     || '4', 10),
  artwork:   parseInt(process.env.CONCURRENCY_ARTWORK   || '2', 10),
  publish:   parseInt(process.env.CONCURRENCY_PUBLISH   || '2', 10),
};

function makeWorker(name, processor, concurrency) {
  const log = (data = {}) => {
    try {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        stage: name,
        ...data,
      }));
    } catch (_) {
      // best-effort
    }
  };
  const worker = new Worker(name, processor, { connection, concurrency, prefix: PREFIX });
  worker.on('active', (job) => {
    log({ event: 'job_started', jobId: job.id, jobName: job.name, data: job.data, attempt: job.attemptsMade });
  });
  worker.on('completed', (job, result) => {
    log({ event: 'job_completed', jobId: job.id, jobName: job.name, duration_ms: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined, resultSummary: result && typeof result === 'object' ? { ...result, ...(result?.length ? { length: result.length } : {}) } : undefined });
  });
  worker.on('failed', (job, err) => {
    log({ event: 'job_failed', jobId: job?.id, jobName: job?.name, data: job?.data, attempt: job?.attemptsMade, name: err?.name, message: err?.message, stack: err?.stack });
  });
  worker.on('error', (err) => {
    log({ event: 'worker_error', name: err?.name, message: err?.message, stack: err?.stack });
  });
  worker.on('stalled', (jobId) => {
    log({ event: 'job_stalled', jobId });
  });
  return worker;
}

makeWorker('catchment', catchment, CONCURRENCY.catchment);
makeWorker('location',  locations, CONCURRENCY.location);
makeWorker('photo',     photos,    CONCURRENCY.photo);
makeWorker('artwork',   artwork,   CONCURRENCY.artwork);
makeWorker('publish',   publish,   CONCURRENCY.publish);