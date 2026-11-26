export interface UserIdentity {
  id: string;
  username: string;
  ownsLegacyData: boolean;
}

export interface IdentitySession {
  user: UserIdentity | null;
}
