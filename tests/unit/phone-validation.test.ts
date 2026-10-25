import { describe, expect, it } from 'vitest';
import { phoneSchema } from '../../src/shared/utils/validation-schemas.js';
import { employeeCreateSchema, employeeUpdateSchema } from '../../src/modules/users/user.validator.js';
import { branchCreateSchema, branchUpdateSchema } from '../../src/modules/branches/branch.validator.js';
import { contactSchema } from '../../src/modules/leads/commercial.validator.js';

const id = '123456789012345678901234';
describe('consistent phone normalization', () => {
  it.each(['9876543210', '+919876543210', '98765 43210'])('normalizes %s to the same stored number', (value) => {
    const result: { error?: unknown; value: unknown } = phoneSchema.validate(value);
    expect(result.error).toBeUndefined(); expect(result.value).toBe('+919876543210');
  });
  it('preserves explicit international numbers and rejects invalid or ambiguous numbers', () => {
    const international: { value: unknown } = phoneSchema.validate('+14155552671');
    expect(international.value).toBe('+14155552671');
    for (const value of ['987654321', '919876543210', '987654321a', '', null, 9876543210]) expect(phoneSchema.validate(value).error).toBeDefined();
  });
  it('normalizes employee creation and update before model uniqueness checks', () => {
    const created: { error?: unknown; value: unknown } = employeeCreateSchema.validate({ employeeCode: 'PHONE-TC', firstName: 'Phone', lastName: 'Fixture', email: 'phone@example.invalid', mobileNumber: '9876543210', roleId: id, branchId: id, reportingManagerId: id, dateOfJoining: '2026-10-22' });
    expect(created.error).toBeUndefined(); expect(created.value).toHaveProperty('mobileNumber', '+919876543210');
    const updated: { error?: unknown; value: unknown } = employeeUpdateSchema.validate({ revision: 0, mobileNumber: '9876543210' });
    expect(updated.error).toBeUndefined(); expect(updated.value).toHaveProperty('mobileNumber', '+919876543210');
  });
  it('normalizes branch contacts and customer/import alternate numbers', () => {
    const branch: { error?: unknown; value: unknown } = branchCreateSchema.validate({ branchCode: 'PHONE', branchName: 'Phone branch', address: 'Phone test address', contactNumber: '9876543210', stateId: id, districtId: id });
    expect(branch.error).toBeUndefined(); expect(branch.value).toHaveProperty('contactNumber', '+919876543210');
    const update: { error?: unknown; value: unknown } = branchUpdateSchema.validate({ revision: 0, contactNumber: '9876543210' });
    expect(update.error).toBeUndefined(); expect(update.value).toHaveProperty('contactNumber', '+919876543210');
    const contact: { error?: unknown; value: unknown } = contactSchema.validate({ customerName: 'Phone fixture', mobileNumber: '9876543210', alternateNumber: '9876543211', stateId: id, districtId: id, siteAddress: 'Phone test address' });
    expect(contact.error).toBeUndefined(); expect(contact.value).toHaveProperty('mobileNumber', '+919876543210'); expect(contact.value).toHaveProperty('alternateNumber', '+919876543211');
  });
});
