import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  parseWithdrawalSelection,
  type WithdrawalSelection,
} from "@/domain/earn/withdrawalSelection";
const key = (walletId: string) =>
  `gizu:withdrawal-selection:v1:${encodeURIComponent(walletId)}:robinhood-usdg`;
/** UI recovery only. Every portion requires native approval and native journal evidence. */
export const withdrawalSelectionStore = {
  async load(walletId: string): Promise<WithdrawalSelection | null> {
    const raw = await AsyncStorage.getItem(key(walletId));
    if (!raw) return null;
    if (raw.length > 100000) return null;
    try {
      return parseWithdrawalSelection(JSON.parse(raw), walletId);
    } catch {
      return null;
    }
  },
  async save(selection: WithdrawalSelection) {
    parseWithdrawalSelection(selection, selection.walletId);
    await AsyncStorage.setItem(key(selection.walletId), JSON.stringify(selection));
  },
  async clear(walletId: string) {
    await AsyncStorage.removeItem(key(walletId));
  },
};
