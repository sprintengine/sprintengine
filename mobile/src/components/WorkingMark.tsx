import { useEffect, useMemo, useState } from "react";
import { Animated, Easing, View } from "react-native";

import { useReducedMotion } from "./motion";
import { useTheme } from "../theme/ThemeProvider";

// WorkingMark — "an agent is working right now": three dots that hop one after
// another, then rest, like a wave passing through an ellipsis. The desktop's
// mark (components/ui/WorkingMark.tsx and its `working-mark` rules), frame for
// frame: the same twelve frames over 1.5s, stepped rather than eased, in the
// success ink. A dot has no shape, but three in a row are an ellipsis, so
// working never reads as waiting.
//
// Every mark on screen reads one shared clock on the native driver, so a
// column of working chats hops together and the phone runs one animation
// however many marks there are. Reduced motion holds the dots at rest: "•••".

export const WORKING_MARK_FRAMES = 12;
export const WORKING_MARK_PERIOD_MS = 1500;

// The desktop's geometry, in its 14-unit frame.
const FRAME = 14;
const DOT_X = [3.3, 7, 10.7];
const DOT_R = 1.35;
const REST_Y = 8.9;
const HOP = 3.4;
/** Frames a dot spends in the air, and how many frames each dot lags the last. */
const HOP_FRAMES = 4;
const LAG = 1;

/** How far a dot is lifted, in frame units, on each of the twelve frames. */
function lifts(dot: number): number[] {
  return Array.from({ length: WORKING_MARK_FRAMES }, (_, frame) => {
    const t = frame - dot * LAG;
    return t > 0 && t < HOP_FRAMES ? HOP * Math.sin((Math.PI * t) / HOP_FRAMES) : 0;
  });
}

// Each frame held flat for its twelfth of the loop: the desktop's steps(12).
const HOLD = 1e-4;
const STEP_INPUT = Array.from({ length: WORKING_MARK_FRAMES }, (_, frame) => [
  frame / WORKING_MARK_FRAMES,
  (frame + 1) / WORKING_MARK_FRAMES - HOLD,
]).flat();

// The one clock every mounted mark reads. Started by the first mark, stopped
// when the last one goes.
let shared: { value: Animated.Value; loop: Animated.CompositeAnimation; marks: number } | null = null;

function useSharedClock(running: boolean): Animated.Value | null {
  const [clock, setClock] = useState<Animated.Value | null>(null);
  useEffect(() => {
    if (!running) return;
    if (!shared) {
      const value = new Animated.Value(0);
      const loop = Animated.loop(
        Animated.timing(value, {
          toValue: 1,
          duration: WORKING_MARK_PERIOD_MS,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
      loop.start();
      shared = { value, loop, marks: 0 };
    }
    shared.marks += 1;
    setClock(shared.value);
    return () => {
      if (!shared) return;
      shared.marks -= 1;
      if (shared.marks === 0) {
        shared.loop.stop();
        shared = null;
      }
    };
  }, [running]);
  return running ? clock : null;
}

export function WorkingMark({
  size = 12,
  color,
  label = "Working",
}: {
  /** The mark's box in points. 12 draws the desktop's 14px mark at phone scale. */
  size?: number;
  /** Dot ink. Defaults to the theme's success green, the desktop's working ink. */
  color?: string;
  /** Accessible name, e.g. "Agent working". */
  label?: string;
}) {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const clock = useSharedClock(!reducedMotion);
  const scale = size / FRAME;
  const diameter = DOT_R * 2 * scale;
  const ink = color ?? colors.toneGood;

  const lifted = useMemo(
    () =>
      DOT_X.map((_, dot) => {
        if (!clock) return undefined;
        const outputRange = lifts(dot)
          .map((lift) => [-lift * scale, -lift * scale])
          .flat();
        return [{ translateY: clock.interpolate({ inputRange: STEP_INPUT, outputRange }) }];
      }),
    [clock, scale],
  );

  return (
    <View accessibilityLabel={label} accessibilityRole="image" accessible style={{ width: size, height: size }}>
      {DOT_X.map((x, dot) => (
        <Animated.View
          key={x}
          style={{
            position: "absolute",
            left: (x - DOT_R) * scale,
            top: (REST_Y - DOT_R) * scale,
            width: diameter,
            height: diameter,
            borderRadius: diameter / 2,
            backgroundColor: ink,
            transform: lifted[dot],
          }}
        />
      ))}
    </View>
  );
}
