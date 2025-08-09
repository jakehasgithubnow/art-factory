import { Worker } from 'bullmq';
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
  const worker = new Worker(name, processor, { connection, concurrency, prefix: PREFIX });
  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker:${name}] job failed`, { id: job?.id, name: job?.name, data: job?.data, err });
  });
  worker.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker:${name}] error`, err);
  });
  return worker;
}

makeWorker('catchment', catchment, CONCURRENCY.catchment);
makeWorker('location',  locations, CONCURRENCY.location);
makeWorker('photo',     photos,    CONCURRENCY.photo);
makeWorker('artwork',   artwork,   CONCURRENCY.artwork);
makeWorker('publish',   publish,   CONCURRENCY.publish);