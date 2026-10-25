import { ReportModel, ReportHistoryModel } from './report.model.js';
export async function createReportIndexes(): Promise<void> {
  await ReportModel.createCollection(); await ReportModel.createIndexes();
  await ReportHistoryModel.createCollection(); await ReportHistoryModel.createIndexes();
}
