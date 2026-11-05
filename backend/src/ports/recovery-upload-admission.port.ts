/** The implementation must persist only keyed, expiring client commitments. */
export interface RecoveryUploadAdmission {
  admit(clientIp: string, decodedBytes: number): Promise<boolean>;
}
