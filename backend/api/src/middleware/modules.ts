import type { RequestHandler } from 'express';
import { unprocessable } from '../lib/errors';
import { getModules, MODULE_OFF_MESSAGE, type ModuleFlags } from '../services/modules';

/** Refuses every request of a route family while its module is switched off in the console (module_disabled). */
export const requireModule =
  (key: keyof ModuleFlags): RequestHandler =>
  (_req, _res, next) => {
    if (getModules()[key] === false) return next(unprocessable(MODULE_OFF_MESSAGE, 'module_disabled', { module: key }));
    next();
  };
