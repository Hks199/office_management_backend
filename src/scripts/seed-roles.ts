import mongoose from 'mongoose';
import { runInternal } from './run-internal.js';
import { UserModel } from '../modules/users/user.model.js';
import { createIdentityIndexes } from '../modules/auth/identity-indexes.js';
import { seedSystemRoles } from '../modules/permissions/seed.service.js';

runInternal(async () => {
  await createIdentityIndexes();
  const root = await UserModel.findOne({ bootstrapKey: 'INITIAL_MD', isActive: true }).lean();
  if (!root) throw new Error('Run MD bootstrap first');
  await mongoose.connection.transaction(async (session) => { await seedSystemRoles(root._id, session); });
  process.stdout.write('Missing system roles/policies seeded; existing grants preserved.\n');
});
