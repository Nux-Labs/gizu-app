import { Easing, ReduceMotion, type WithSpringConfig } from "react-native-reanimated";

// Frontend motion language (framer-motion) translated to Reanimated.
// Every config opts into the OS reduced-motion preference.
export const reduceMotion = ReduceMotion.System;

/** Frontend `ease: [0.22, 1, 0.36, 1]`. */
export const easeOut = Easing.bezier(0.22, 1, 0.36, 1);

export const durations = {
  press: 120,
  screen: 380,
  reveal: 560,
  fadeIn: 450,
} as const;

export const timing = {
  screen: { duration: durations.screen, easing: easeOut, reduceMotion },
  fadeIn: { duration: durations.fadeIn, easing: easeOut, reduceMotion },
  reveal: { duration: durations.reveal, easing: easeOut, reduceMotion },
  press: { duration: durations.press, easing: easeOut, reduceMotion },
} as const;

function spring(stiffness: number, damping: number): WithSpringConfig {
  return { stiffness, damping, mass: 1, reduceMotion };
}

export const springs = {
  navPill: spring(380, 30),
  navEnter: spring(260, 26),
  sheet: spring(250, 30),
  bubble: spring(300, 32),
  check: spring(220, 18),
} as const;

export const stagger = {
  sectionStep: 60,
  cardBase: 300,
  cardStep: 50,
} as const;

/** Delay for the n-th section of a screen (frontend: 60ms steps). */
export function sectionDelay(index: number): number {
  return Math.max(0, index) * stagger.sectionStep;
}

/** Delay for the n-th card in a list (frontend: 300 + 50·i ms). */
export function cardDelay(index: number): number {
  return stagger.cardBase + Math.max(0, index) * stagger.cardStep;
}
