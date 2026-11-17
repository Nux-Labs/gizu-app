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
