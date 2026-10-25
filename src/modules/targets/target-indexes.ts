import { TargetModel, TargetRevisionModel, TargetEvidenceModel, TargetEvidenceReviewModel } from './target.model.js';
import { ReportModel } from '../reports/report.model.js';
export async function createTargetIndexes(): Promise<void> {
  for (const model of [TargetModel, TargetRevisionModel, TargetEvidenceModel, TargetEvidenceReviewModel]) { await model.createCollection(); await model.createIndexes(); }
  await ReportModel.collection.createIndex({ employeeId: 1, branchId: 1, kind: 1, reviewStatus: 1, callEndedAt: 1 });
  await ReportModel.collection.createIndex({ employeeId: 1, branchId: 1, kind: 1, reviewStatus: 1, visitCompletedAt: 1 });
}
