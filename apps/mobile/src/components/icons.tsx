// The app's line icons, the same drawings as the desktop's (`packages/ui/src/icons.tsx`):
// a 16-unit grid and a 1.6 stroke with round ends.

import type { ReactNode } from "react";
import Svg, { Circle, Path } from "react-native-svg";
import { ICON_PATHS } from "./icon-paths.ts";

type IconProps = { color: string; size?: number };

function Line({ d, color, size = 16, children }: IconProps & { d: string; children?: ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path d={d} stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      {children}
    </Svg>
  );
}

export const BackIcon = (props: IconProps) => <Line d={ICON_PATHS.back} {...props} />;
export const ChevronIcon = (props: IconProps) => <Line d={ICON_PATHS.chevron} {...props} />;
export const CloseIcon = (props: IconProps) => <Line d={ICON_PATHS.close} {...props} />;

export const SettingsIcon = ({ color, size = 16 }: IconProps) => (
  <Line d={ICON_PATHS.settings} color={color} size={size}>
    <Circle cx="10" cy="5" r="1.75" stroke={color} strokeWidth={1.6} />
    <Circle cx="6" cy="11" r="1.75" stroke={color} strokeWidth={1.6} />
  </Line>
);

export const EyeIcon = ({ color, size = 16 }: IconProps) => (
  <Line d={ICON_PATHS.eye} color={color} size={size}>
    <Circle cx="8" cy="8" r="1.9" stroke={color} strokeWidth={1.6} />
  </Line>
);

export const StarIcon = ({ color, size = 16 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16">
    <Path d={ICON_PATHS.star} fill={color} />
  </Svg>
);
