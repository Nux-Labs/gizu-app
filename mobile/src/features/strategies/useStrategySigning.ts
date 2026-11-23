import { useEffect, useState } from "react";
import { getSignerCapabilities } from "@/services/wallet/nativeBridge";

/** Whether this build can sign Sealed Strategies; false until the native check answers. */
export function useStrategySigning(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    // Any failure, even a synchronous one from a partial native module, means "unavailable".
    Promise.resolve()
      .then(() => getSignerCapabilities())
      .then((capabilities) => {
        if (active) setAvailable(capabilities.strategySigning === true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return available;
}
