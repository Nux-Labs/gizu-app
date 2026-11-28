export type EarlyAccessSignup = {
  email: string;
  platform?: "ios" | "android" | "both";
  source?: "landing-hero" | "landing-footer" | "landing-ios" | "landing-android";
  consent?: true;
  consentVersion?: "2026-11-17";
  consentRecordedAt?: string;
  investmentRange?: string;
  platforms?: string[];
  otherPlatform?: string;
};

export interface EarlyAccess {
  add(signup: EarlyAccessSignup): Promise<void>;
}

export type EarlyAccessRecord = {
  email: string;
  createdAt: Date;
  platform: string | null;
  source: string | null;
  consent: boolean;
  consentRecordedAt: string | null;
};

/** Read-only operator view of signups; kept separate from the public write port. */
export interface EarlyAccessReader {
  list(): Promise<EarlyAccessRecord[]>;
}
