import { OfficeSettingsModel } from './office-settings.model.js';
import { AttendanceModel } from './attendance.model.js';
import { FileModel } from '../files/file.model.js';
export async function createAttendanceIndexes(): Promise<void> {
  for (const model of [AttendanceModel, FileModel, OfficeSettingsModel]) { await model.createCollection(); await model.createIndexes(); }
}
