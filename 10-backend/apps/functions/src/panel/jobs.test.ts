import { describe, it, expect } from 'vitest';
import { PANEL_JOB_ACTIONS, isPanelJobAction } from './jobs.js';

describe('panel jobs', () => {
  it('expone exactamente las 8 acciones de la Fase 2', () => {
    expect([...PANEL_JOB_ACTIONS].sort()).toEqual(
      [
        'catalogSync',
        'computeAttribution',
        'computeTracking',
        'generateAudits',
        'generateFollowups',
        'generateWinningReplies',
        'metaAdsSync',
        'processConversions',
      ].sort(),
    );
  });

  it('valida nombres de acción', () => {
    expect(isPanelJobAction('metaAdsSync')).toBe(true);
    expect(isPanelJobAction('computeTracking')).toBe(true);
    expect(isPanelJobAction('devSyncMetaAds')).toBe(false);
    expect(isPanelJobAction('')).toBe(false);
  });
});
