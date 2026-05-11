import crypto from 'node:crypto';
import { CHARON_MACHINE_ID } from '../config.js';
import { setting, setSetting } from './settings.js';

let cachedMachineId = null;

export function machineId() {
  if (cachedMachineId) return cachedMachineId;
  if (CHARON_MACHINE_ID) {
    cachedMachineId = CHARON_MACHINE_ID;
    setSetting('machine_id', cachedMachineId);
    return cachedMachineId;
  }
  const stored = setting('machine_id', '');
  if (stored) {
    cachedMachineId = stored;
    return cachedMachineId;
  }
  cachedMachineId = crypto.randomUUID();
  setSetting('machine_id', cachedMachineId);
  return cachedMachineId;
}
