import { AttendanceCalendarModel, DashboardExportModel } from './dashboard.model.js';
import { LeadModel, CustomerModel } from '../leads/commercial.models.js';
import { ReportModel } from '../reports/report.model.js';
import { TargetEvidenceModel } from '../targets/target.model.js';
export async function createDashboardIndexes(): Promise<void> {
  await AttendanceCalendarModel.createCollection(); await AttendanceCalendarModel.createIndexes();
  await DashboardExportModel.createCollection(); await DashboardExportModel.createIndexes();
  await LeadModel.collection.createIndex({ branchId: 1, createdAt: 1, status: 1 }); await CustomerModel.collection.createIndex({ branchId: 1, createdAt: 1, status: 1 });
  await ReportModel.collection.createIndex({ branchId: 1, reviewStatus: 1, callEndedAt: 1 }); await ReportModel.collection.createIndex({ branchId: 1, reviewStatus: 1, visitCompletedAt: 1 });
  await TargetEvidenceModel.collection.createIndex({ branchId: 1, reviewStatus: 1, occurredAt: 1, milestone: 1 });
}
