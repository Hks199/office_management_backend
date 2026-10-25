import { open } from 'node:fs/promises';
import { runInternal } from './run-internal.js';
import { createOrganizationIndexes } from '../modules/hierarchy/organization-indexes.js';
import { seedLocations } from '../modules/locations/location-seed.service.js';
runInternal(async () => {
  const path = process.env.LOCATION_SEED_FILE; if (!path) throw new Error('LOCATION_SEED_FILE is required');
  const file = await open(path, 'r');
  let input: unknown;
  try {
    const buffer = Buffer.alloc(5 * 1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 5 * 1024 * 1024) throw new Error('Location seed exceeds 5 MiB');
    input = JSON.parse(buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/, '')) as unknown;
  } finally { await file.close(); }
  await createOrganizationIndexes(); const count = await seedLocations(input);
  process.stdout.write(`Vetted location records processed: ${String(count)}. Existing data was preserved.\n`);
});
