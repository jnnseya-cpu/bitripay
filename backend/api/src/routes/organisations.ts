/**
 * Organisations, members and business units (specification §43, §44). Merchant-class accounts own their organisation;
 * members reach it with their own session (middleware/auth resolves the membership) and every write is checked
 * against the permission matrix with `requireOrgPermission`.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../lib/http';
import { requireAuth, requireOrgPermission, requireRole } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { MERCHANT_ROLES } from '../services/users';
import { ORG_PERMISSION_KEYS, ORG_ROLES } from '@bitripay/shared';
import {
  createBusinessUnit,
  customersCsv,
  deleteBusinessUnit,
  ensureOrganisation,
  exportCustomers,
  getBusinessUnit,
  inviteMember,
  linkLocationToBusinessUnit,
  listBusinessUnits,
  listMembers,
  organisationSummary,
  removeMember,
  updateBusinessUnit,
  updateMemberRole,
  updateOrganisation,
  type OrganisationRow,
} from '../services/organisations';
import { badRequest } from '../lib/errors';

export const organisationsRouter = Router();
const writeLimit = rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'orgw' });

// Merchant-class accounts (owners), their members (resolved to the owner by the middleware) and administrators.
organisationsRouter.use(requireAuth, requireRole(...MERCHANT_ROLES, 'admin'));

/** The organisation the request acts for; a merchant-class account that predates organisations gets one here. */
function currentOrganisation(req: import('express').Request): OrganisationRow {
  if (req.organisation) return req.organisation;
  if (req.user!.role === 'admin') throw badRequest('Administrators do not own an organisation; sign in as the merchant or one of its members', 'no_organisation');
  const org = ensureOrganisation(req.user!);
  req.organisation = org;
  req.organisationRole = 'owner';
  req.organisationPermissions = ['*'];
  return org;
}
const ctxOf = (req: import('express').Request) => (req.organisationRole ? { organisation: req.organisation!, role: req.organisationRole, permissions: req.organisationPermissions ?? [] } : null);
const actorOf = (req: import('express').Request) => req.actor ?? req.user!;

organisationsRouter.get('/me', (req, res) => res.json(organisationSummary(currentOrganisation(req), ctxOf(req), actorOf(req))));
organisationsRouter.get('/roles', (_req, res) => res.json({ roles: ORG_ROLES, permissions: ORG_PERMISSION_KEYS }));

organisationsRouter.patch('/me', requireOrgPermission('org:settings'), writeLimit, (req, res) => {
  const b = validate(z.object({ name: z.string().min(2).max(120).optional().nullable(), cashierRefundLimitMinor: z.number().int().min(0).optional().nullable() }), req.body ?? {});
  res.json(organisationSummary(updateOrganisation(currentOrganisation(req), actorOf(req), b), ctxOf(req), actorOf(req)));
});

// ---------------------------------------------------------------------------------------------------------------------
// Members: owners and administrators invite by email, phone or @tag, change roles and remove people
// ---------------------------------------------------------------------------------------------------------------------
organisationsRouter.get('/members', (req, res) => res.json({ data: listMembers(currentOrganisation(req).id) }));
organisationsRouter.post('/members', requireOrgPermission('org:manage_members'), writeLimit, (req, res) => {
  const b = validate(z.object({ identifier: z.string().min(2).max(160), role: z.enum(ORG_ROLES), permissions: z.array(z.enum(ORG_PERMISSION_KEYS)).max(30).optional() }), req.body);
  res.status(201).json(inviteMember(currentOrganisation(req), actorOf(req), b));
});
organisationsRouter.patch('/members/:id', requireOrgPermission('org:manage_members'), writeLimit, (req, res) => {
  const b = validate(z.object({ role: z.enum(ORG_ROLES), permissions: z.array(z.enum(ORG_PERMISSION_KEYS)).max(30).optional() }), req.body);
  res.json(updateMemberRole(currentOrganisation(req), actorOf(req), String(req.params.id), b));
});
organisationsRouter.delete('/members/:id', requireOrgPermission('org:manage_members'), writeLimit, (req, res) => res.json(removeMember(currentOrganisation(req), actorOf(req), String(req.params.id))));

// ---------------------------------------------------------------------------------------------------------------------
// Business units
// ---------------------------------------------------------------------------------------------------------------------
const unitSchema = z.object({ name: z.string().min(2).max(80), code: z.string().min(2).max(16).optional().nullable(), settlementProfileId: z.string().max(60).optional().nullable() });
organisationsRouter.get('/business-units', (req, res) => res.json({ data: listBusinessUnits(currentOrganisation(req).id) }));
organisationsRouter.post('/business-units', requireOrgPermission('org:manage_units'), writeLimit, (req, res) =>
  res.status(201).json(createBusinessUnit(currentOrganisation(req), actorOf(req), validate(unitSchema, req.body))),
);
organisationsRouter.get('/business-units/:id', (req, res) => res.json(getBusinessUnit(currentOrganisation(req), String(req.params.id))));
organisationsRouter.patch('/business-units/:id', requireOrgPermission('org:manage_units'), writeLimit, (req, res) =>
  res.json(updateBusinessUnit(currentOrganisation(req), actorOf(req), String(req.params.id), validate(unitSchema.partial(), req.body ?? {}))),
);
organisationsRouter.delete('/business-units/:id', requireOrgPermission('org:manage_units'), writeLimit, (req, res) =>
  res.json(deleteBusinessUnit(currentOrganisation(req), actorOf(req), String(req.params.id))),
);
/** Attach a location (its terminals and QR codes follow) to a business unit; `businessUnitId: null` detaches it. */
organisationsRouter.patch('/locations/:id', requireOrgPermission('org:manage_units'), writeLimit, (req, res) => {
  const b = validate(z.object({ businessUnitId: z.string().max(40).nullable() }), req.body ?? {});
  res.json(linkLocationToBusinessUnit(currentOrganisation(req), actorOf(req), String(req.params.id), b.businessUnitId));
});

// ---------------------------------------------------------------------------------------------------------------------
// Customer export (personal data): finance managers, administrators and the owner
// ---------------------------------------------------------------------------------------------------------------------
organisationsRouter.get('/customers/export', requireOrgPermission('customers:export'), (req, res) => {
  const rows = exportCustomers(currentOrganisation(req));
  if (String(req.query.format ?? 'json') === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8').setHeader('Content-Disposition', 'attachment; filename="customers.csv"').send(customersCsv(rows));
    return;
  }
  res.json({ data: rows });
});
