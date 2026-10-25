import { runInternal } from './run-internal.js';
import { UserModel } from '../modules/users/user.model.js';

runInternal(async () => {
  await UserModel.collection.createIndex({ reportingManagerIds: 1, isActive: 1 });
  process.stdout.write('Multiple reporting manager index is ready. Existing assignments are unchanged.\n');
});
