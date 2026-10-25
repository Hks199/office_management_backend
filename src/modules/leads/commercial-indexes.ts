import { Types } from 'mongoose';
import { LeadModel, CustomerModel, AssignmentModel, LeadEventModel, ProposalModel, ReferenceModel, WorkflowModel, CommercialSettingsModel, IdempotencyModel } from './commercial.models.js';
import { ImportModel, ImportRowModel, LeadExportModel } from '../csv-imports/import.models.js';
import { defaultTransitions } from './workflow.service.js';
import { seedPermissions } from '../permissions/seed.service.js';
import { TargetEvidenceModel } from '../targets/target.model.js';
import { ConfirmedCustomerModel } from '../sales-customers/customer.model.js';
export async function createCommercialIndexes(): Promise<void> {
  for (const model of [LeadModel, CustomerModel, ConfirmedCustomerModel, AssignmentModel, LeadEventModel, ProposalModel, ReferenceModel, WorkflowModel, CommercialSettingsModel, IdempotencyModel, ImportModel, ImportRowModel, LeadExportModel, TargetEvidenceModel]) {
    await model.createCollection(); await model.createIndexes();
  }
  await seedPermissions();
  await CommercialSettingsModel.updateOne({ _id: 'customers' }, { $setOnInsert: { duplicateScope: 'BRANCH', revision: 0 } }, { upsert: true });
  // A reserved zero ObjectId identifies the built-in system workflow, never an authenticated employee.
  if (!await WorkflowModel.exists({ version: 1 })) await WorkflowModel.create({ version: 1, transitions: defaultTransitions, createdBy: new Types.ObjectId('000000000000000000000000') });
}
