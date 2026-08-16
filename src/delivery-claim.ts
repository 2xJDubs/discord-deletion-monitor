import { randomUUID } from "node:crypto";

type ClaimStore = {
  claimDelivery(messageId: string, token: string, now?: Date, leaseMs?: number): boolean;
};
type ClaimedDelivery = (guildId: string, messageId: string, claimToken: string) => Promise<boolean>;
type ClaimOptions = {
  now?: () => Date;
  token?: () => string;
  leaseMs?: number;
};

export async function deliverWithClaim(
  guildId: string,
  messageId: string,
  store: ClaimStore,
  deliver: ClaimedDelivery,
  options: ClaimOptions = {},
): Promise<boolean> {
  const claimToken = (options.token ?? randomUUID)();
  const now = (options.now ?? (() => new Date()))();
  const leaseMs = options.leaseMs ?? 5 * 60_000;
  if (!store.claimDelivery(messageId, claimToken, now, leaseMs)) return false;
  return deliver(guildId, messageId, claimToken);
}
