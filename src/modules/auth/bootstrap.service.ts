import mongoose, { Types } from 'mongoose';
import { UserModel } from '../users/user.model.js';
import { SecurityStateModel } from './auth.models.js';
import { seedSystemRoles } from '../permissions/seed.service.js';
import { AuthRepository } from './auth.repository.js';
import { audit } from '../activity-logs/audit.service.js';
import { encryptSecret, randomToken, tokenHash } from '../../shared/utils/crypto.js';
import { AppError } from '../../shared/errors/app-error.js';

export interface BootstrapIdentity { employeeCode: string; firstName: string; lastName: string; email: string; mobileNumber: string }
export async function bootstrapMd(identity: BootstrapIdentity, encryptionKey: string): Promise<Types.ObjectId> {
  return mongoose.connection.transaction(async (session) => {
    await SecurityStateModel.updateOne({ _id: 'bootstrap' }, { $inc: { revision: 1 } }, { upsert: true, session });
    if (await UserModel.exists({}).session(session)) {
      throw new AppError(409, 'ALREADY_BOOTSTRAPPED', 'The initial MD is already provisioned');
    }
    const id = new Types.ObjectId();
    const roles = await seedSystemRoles(id, session);
    const roleId = roles.get('MD'); if (!roleId) throw new Error('MD seed missing');
    await UserModel.create([{ _id: id, ...identity, roleId, reportingManagerId: null, branchId: null,
      createdBy: id, dateOfJoining: new Date(), bootstrapKey: 'INITIAL_MD' }], { session });
    const token = randomToken();
    await new AuthRepository().queueCredential(id, 'INVITATION', tokenHash(token), encryptSecret(token, encryptionKey),
      new Date(Date.now() + 86400000), session);
    await audit(session, { requestId: 'internal-bootstrap' }, 'MD_BOOTSTRAPPED', id, 'user', id);
    return id;
  });
}
