import { Types } from 'mongoose';
import { AppError } from '../../shared/errors/app-error.js';

export function managerIds(employee: { reportingManagerId?: Types.ObjectId | null | undefined;
  reportingManagerIds?: Types.ObjectId[] | undefined }): Types.ObjectId[] {
  const ids = [...(employee.reportingManagerId ? [employee.reportingManagerId] : []), ...(employee.reportingManagerIds ?? [])];
  return [...new Map(ids.map((id) => [id.toHexString(), id])).values()];
}

export function managerSelection(input: { reportingManagerId?: string | undefined; reportingManagerIds?: string[] | undefined }) {
  const ids = input.reportingManagerIds ?? (input.reportingManagerId ? [input.reportingManagerId] : []);
  if (!ids.length || ids.length > 10 || new Set(ids.map((id) => id.toLowerCase())).size !== ids.length ||
    ids.some((id) => !/^[a-f\d]{24}$/i.test(id)) ||
    (input.reportingManagerId && input.reportingManagerIds && input.reportingManagerId !== ids[0])) {
    throw new AppError(400, 'INVALID_MANAGERS', 'Choose one to ten distinct reporting managers');
  }
  return { reportingManagerId: new Types.ObjectId(ids[0]), reportingManagerIds: ids.map((id) => new Types.ObjectId(id)) };
}
