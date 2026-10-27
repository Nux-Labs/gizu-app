import AsyncStorage from "@react-native-async-storage/async-storage";
import mockSafeAreaContext from "react-native-safe-area-context/jest/mock";
// Native boundaries only; preference serialization and controllers remain real.
jest.mock("@react-native-async-storage/async-storage", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock("react-native-safe-area-context", () => mockSafeAreaContext);
// Native animation runtime is unavailable in Jest.
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ...require("react-native-reanimated/mock"),
  // The official mock omits this hook; tests run with motion enabled.
  useReducedMotion: jest.fn(() => false),
  useFrameCallback: () => ({ setActive: () => undefined, isActive: false, callbackId: -1 }),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("react-native-worklets", () => require("react-native-worklets/lib/module/mock"));
jest.mock("lottie-react-native", () => ({ __esModule: true, default: "LottieView" }));
// Skia renders on the GPU, Jest only needs the component surface.
jest.mock("@shopify/react-native-skia", () => ({
  __esModule: true,
  Canvas: "SkiaCanvas",
  Fill: "SkiaFill",
  Shader: "SkiaShader",
  Points: "SkiaPoints",
  Atlas: "SkiaAtlas",
  Picture: "SkiaPicture",
  createPicture: () => ({}),
  matchFont: () => ({ getTextWidth: () => 6 }),
  FilterMode: { Linear: 1 },
  MipmapMode: { Linear: 2 },
  TileMode: { Clamp: 0 },
  Skia: {
    RuntimeEffect: { Make: () => ({}) },
    Surface: { Make: () => null },
    Color: () => new Float32Array(4),
    XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
  },
  useRSXformBuffer: () => ({ value: [] }),
  useClock: () => ({ value: 0 }),
  vec: (x: number, y: number) => ({ x, y }),
}));
beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});
