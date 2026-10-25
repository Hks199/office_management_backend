import { CredentialDeliveryModel } from '../auth/credential-delivery.model.js';
import { ImportModel, LeadExportModel } from '../csv-imports/import.models.js';
import { DashboardExportModel } from '../dashboards/dashboard.model.js';

export interface QueueObservation { status: string; count: number; oldestCreatedAt: Date }
export class OperationsRepository {
  async queues(): Promise<Record<string, QueueObservation[]>> {
    const queues: Record<string, QueueObservation[]> = {};
    // No provider payloads, employee IDs, encrypted credentials, leases or error text.
    for (const model of [CredentialDeliveryModel, ImportModel, LeadExportModel, DashboardExportModel]) {
      queues[model.collection.collectionName] = await model.aggregate<QueueObservation>([
        { $match: { status: { $in: ['PENDING', 'PROCESSING', 'FAILED', 'QUEUED_VALIDATION', 'VALIDATING', 'QUEUED_COMMIT', 'QUEUED'] } } },
        { $group: { _id: '$status', count: { $sum: 1 }, oldestCreatedAt: { $min: '$createdAt' } } },
        { $project: { _id: 0, status: '$_id', count: 1, oldestCreatedAt: 1 } }, { $sort: { status: 1 } },
      ]).option({ maxTimeMS: 3000 });
    }
    return queues;
  }
}
