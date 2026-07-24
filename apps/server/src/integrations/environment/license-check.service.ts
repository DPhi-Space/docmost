import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EnvironmentService } from './environment.service';
import { Feature } from '../../common/features';

// Features whose enforcement logic ships natively in this fork (not in the
// stripped-out ee/ dir), so they are unlocked in the OSS build regardless of
// any enterprise license. Each entry below has working backend enforcement
// already wired in — enabling the flag only surfaces the existing toggle:
//   - API_KEYS: native REST API-keys backend (core/api-key).
//   - SECURITY_SETTINGS: backend write-gate for restrictApiToAdmins
//     (core/api-key/api-key.controller enforces at create time),
//     disablePublicSharing (share.service enforces), and trashRetentionDays
//     (page/services/trash-cleanup.service runs the retention job).
//   - SHARING_CONTROLS: frontend gate for the disable-public-sharing toggles
//     (workspace + space); enforcement lives in share.service.
//   - RETENTION: frontend gate for the trash-retention config; the cleanup
//     job already honors the stored value.
//   - VIEWER_COMMENTS: frontend + space-service gate for letting viewers
//     comment; enforced in page-access.service (validateCanComment).
//   - TEMPLATES: native page-templates backend (core/template) — CRUD +
//     "use template" instantiation, with space/global access control and the
//     allowMemberTemplates gate enforced in template.controller.
const FORK_ENABLED_FEATURES: string[] = [
  Feature.API_KEYS,
  Feature.SECURITY_SETTINGS,
  Feature.SHARING_CONTROLS,
  Feature.RETENTION,
  Feature.VIEWER_COMMENTS,
  Feature.TEMPLATES,
];

@Injectable()
export class LicenseCheckService {
  constructor(
    private moduleRef: ModuleRef,
    private environmentService: EnvironmentService,
  ) {}

  isValidEELicense(licenseKey: string): boolean {
    if (this.environmentService.isCloud()) {
      return true;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LicenseModule = require('../../ee/licence/license.service');
      const licenseService = this.moduleRef.get(LicenseModule.LicenseService, {
        strict: false,
      });
      return licenseService.isValidEELicense(licenseKey);
    } catch {
      return false;
    }
  }

  hasFeature(licenseKey: string, feature: string, plan?: string): boolean {
    // Fork-enabled features are unlocked regardless of license/plan. This must
    // mirror resolveFeatures() so the backend write-gates (e.g. workspace
    // SECURITY_SETTINGS) accept the toggles the frontend already surfaces.
    if (FORK_ENABLED_FEATURES.includes(feature)) {
      return true;
    }

    if (this.environmentService.isCloud()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getFeaturesForCloudPlan } = require('../../ee/licence/feature-registry');
        return getFeaturesForCloudPlan(plan).has(feature);
      } catch {
        return false;
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LicenseModule = require('../../ee/licence/license.service');
      const licenseService = this.moduleRef.get(LicenseModule.LicenseService, {
        strict: false,
      });
      return licenseService.hasFeature(licenseKey, feature);
    } catch {
      return false;
    }
  }

  getFeatures(licenseKey: string): string[] {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LicenseModule = require('../../ee/licence/license.service');
      const licenseService = this.moduleRef.get(LicenseModule.LicenseService, {
        strict: false,
      });
      return licenseService.getFeatures(licenseKey);
    } catch {
      return [];
    }
  }

  resolveFeatures(licenseKey: string, plan: string): string[] {
    let features: string[];

    if (this.environmentService.isCloud()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getFeaturesForCloudPlan } = require('../../ee/licence/feature-registry');
        features = [...getFeaturesForCloudPlan(plan)];
      } catch {
        features = [];
      }
    } else {
      features = this.getFeatures(licenseKey);
    }

    // Advertise the fork-enabled features (e.g. API keys) on top of whatever the
    // license/plan grants, de-duplicated. This un-disables the shipped UI.
    return [...new Set([...features, ...FORK_ENABLED_FEATURES])];
  }

  resolveTier(licenseKey: string, plan: string): string {
    if (this.environmentService.isCloud()) {
      return plan ?? 'standard';
    }

    return this.getLicenseType(licenseKey) ?? 'free';
  }

  private getLicenseType(licenseKey: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LicenseModule = require('../../ee/licence/license.service');
      const licenseService = this.moduleRef.get(LicenseModule.LicenseService, {
        strict: false,
      });
      return licenseService.getLicenseType(licenseKey);
    } catch {
      return null;
    }
  }
}
