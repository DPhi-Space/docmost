import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EnvironmentService } from './environment.service';
import { Feature } from '../../common/features';

// This fork ships a native (non-EE) API-keys backend, so the API-keys feature
// is unlocked in the OSS build regardless of any enterprise license.
const FORK_ENABLED_FEATURES: string[] = [Feature.API_KEYS];

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
